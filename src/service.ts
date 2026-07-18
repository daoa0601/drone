import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { Effect, Fiber } from "effect";
import type { Fiber as EffectFiber } from "effect/Fiber";

import { AppleNativeProvider } from "./apple-native.js";
import { encodeExecutionAttestation } from "./attestation.js";
import { ArtifactStore } from "./artifact-store.js";
import type { VerifiedArtifact } from "./artifact-store.js";
import type { DroneConfig } from "./config.js";
import type {
  ArtifactMetadata,
  JobOutputArtifact,
  JobRecord,
  JobSubmission,
  ProviderExecution,
  ProviderId,
  ProviderStatus,
  PublicOperation,
  ResolvedInputArtifact,
} from "./domain.js";
import { DroneError, providerFailed } from "./errors.js";
import { createJobId, JobStore } from "./job-store.js";
import { OperationRegistry } from "./operation-registry.js";
import type { SandboxProvider } from "./provider.js";

type JobFiber = EffectFiber<unknown, unknown>;

function effectPromise<A>(
  operation: () => Promise<A>,
  message: string,
): Effect.Effect<A, DroneError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => (cause instanceof DroneError ? cause : providerFailed(message, cause)),
  });
}

export class DroneService {
  readonly config: DroneConfig;
  readonly artifacts: ArtifactStore;
  readonly registry: OperationRegistry;
  readonly jobs: JobStore;
  readonly #providers: ReadonlyMap<ProviderId, SandboxProvider>;
  readonly #active = new Map<string, JobFiber>();
  #reservedSlots = 0;
  #initialization: Promise<void> | undefined;

  constructor(
    config: DroneConfig,
    options: {
      readonly artifacts?: ArtifactStore;
      readonly registry?: OperationRegistry;
      readonly jobs?: JobStore;
      readonly providers?: ReadonlyArray<SandboxProvider>;
    } = {},
  ) {
    this.config = config;
    this.artifacts =
      options.artifacts ?? new ArtifactStore(config.artifactRoot, config.maxArtifactBytes);
    this.registry = options.registry ?? new OperationRegistry(config.operationsFile);
    this.jobs = options.jobs ?? new JobStore(config.jobsRoot);
    const providers = options.providers ?? [
      new AppleNativeProvider({
        enabled: config.appleNativeEnabled,
        driverPath: config.appleNativeDriver,
        kernelPath: config.appleNativeKernel,
        initfsPath: config.appleNativeInitfs,
        stateRoot: config.appleNativeStateRoot,
        runsRoot: config.runsRoot,
        attestationFile: config.appleNativeAttestationFile,
        attestationPublicKey: config.appleNativeAttestationPublicKey,
      }),
    ];
    this.#providers = new Map(providers.map((provider) => [provider.providerId, provider]));
  }

  get activeJobCount(): number {
    return this.#reservedSlots;
  }

  initialize(): Promise<void> {
    this.#initialization ??= (async () => {
      await mkdir(this.config.droneHome, { recursive: true, mode: 0o700 });
      await mkdir(this.config.runsRoot, { recursive: true, mode: 0o700 });
      await this.artifacts.initialize();
      await this.registry.initialize();
      await this.jobs.initialize();
    })();
    return this.#initialization;
  }

  async providers(): Promise<ReadonlyArray<ProviderStatus>> {
    await this.initialize();
    return Promise.all(
      [...this.#providers.values()]
        .sort((left, right) => left.providerId.localeCompare(right.providerId))
        .map((provider) => provider.status()),
    );
  }

  async operations(): Promise<ReadonlyArray<PublicOperation>> {
    await this.initialize();
    return this.registry.list();
  }

  async stageArtifact(bytes: Uint8Array, mediaType: string): Promise<ArtifactMetadata> {
    await this.initialize();
    return this.artifacts.stage(bytes, mediaType);
  }

  async artifact(artifactId: string): Promise<ArtifactMetadata> {
    await this.initialize();
    return this.artifacts.inspect(artifactId);
  }

  async artifactBytes(artifactId: string): Promise<VerifiedArtifact> {
    await this.initialize();
    return this.artifacts.read(artifactId);
  }

  async submit(input: JobSubmission): Promise<JobRecord> {
    await this.initialize();
    const operation = this.registry.get(input.operation_id);
    const provider = this.#providers.get(operation.provider);
    if (provider === undefined) {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "The operation provider is not configured.",
        status: 503,
        expose: false,
      });
    }
    const providerStatus = await provider.status();
    if (!providerStatus.mutations_available) {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "The operation provider is not ready.",
        status: 503,
      });
    }
    if (!providerStatus.attested || providerStatus.attestation === undefined) {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "The operation provider has no valid independent attestation.",
        status: 503,
      });
    }
    if (providerStatus.attestation.attestation_id !== input.provider_attestation_id) {
      throw new DroneError({
        code: "CONFLICT",
        message: "The approved provider attestation is no longer current.",
        status: 409,
      });
    }
    const declaredSlots = new Map(operation.inputs.map((slot) => [slot.name, slot]));
    for (const supplied of Object.keys(input.inputs)) {
      if (!declaredSlots.has(supplied)) {
        throw new DroneError({
          code: "INVALID_INPUT",
          message: `Input slot ${supplied} is not declared by the operation.`,
          status: 400,
        });
      }
    }
    for (const slot of operation.inputs) {
      if (slot.required && input.inputs[slot.name] === undefined) {
        throw new DroneError({
          code: "INVALID_INPUT",
          message: `Required input slot ${slot.name} is missing.`,
          status: 400,
        });
      }
    }
    const resolvedInputs: Array<ResolvedInputArtifact> = [];
    for (const [name, artifactId] of Object.entries(input.inputs)) {
      const slot = declaredSlots.get(name)!;
      const { metadata, bytes } = await this.artifacts.read(artifactId);
      if (metadata.size_bytes > slot.max_bytes) {
        throw new DroneError({
          code: "ARTIFACT_LIMIT_EXCEEDED",
          message: `Input slot ${name} exceeds its operation limit.`,
          status: 413,
        });
      }
      if (!slot.media_types.includes(metadata.media_type)) {
        throw new DroneError({
          code: "ARTIFACT_INVALID",
          message: `Input slot ${name} has an unsupported media type.`,
          status: 400,
        });
      }
      resolvedInputs.push({
        slot,
        metadata,
        bytes,
      });
    }
    if (this.#reservedSlots >= this.config.maxActiveJobs) {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "The active sandbox limit has been reached.",
        status: 503,
      });
    }

    this.#reservedSlots += 1;
    let started = false;
    try {
      const jobId = createJobId();
      const job: JobRecord = {
        schema_version: "1",
        job_id: jobId,
        operation_id: operation.operation_id,
        provider_id: operation.provider,
        provider_attestation_id: input.provider_attestation_id,
        status: "queued",
        inputs: input.inputs,
        outputs: [],
        submitted_at: new Date().toISOString(),
      };
      await this.jobs.create(job);
      const execution: ProviderExecution = {
        job_id: jobId,
        provider_attestation_id: input.provider_attestation_id,
        attestation_challenge: randomBytes(32).toString("hex"),
        operation,
        inputs: resolvedInputs,
      };
      const fiber = Effect.runFork(this.#execute(job, provider, execution)) as JobFiber;
      this.#active.set(jobId, fiber);
      started = true;
      void Effect.runPromise(Fiber.await(fiber)).finally(() => {
        if (this.#active.get(jobId) === fiber) {
          this.#active.delete(jobId);
          this.#reservedSlots -= 1;
        }
      });
      return job;
    } finally {
      if (!started) this.#reservedSlots -= 1;
    }
  }

  async inspectJob(jobId: string): Promise<JobRecord> {
    await this.initialize();
    return this.jobs.get(jobId);
  }

  async listJobs(): Promise<ReadonlyArray<JobRecord>> {
    await this.initialize();
    return (await this.jobs.list()).slice(0, 100);
  }

  async cancel(jobId: string): Promise<JobRecord> {
    await this.initialize();
    const fiber = this.#active.get(jobId);
    if (fiber === undefined) {
      throw new DroneError({
        code: "JOB_NOT_ACTIVE",
        message: "Job is not active in this Drone process.",
        status: 409,
      });
    }
    await Effect.runPromise(Fiber.interrupt(fiber));
    const current = await this.jobs.get(jobId);
    if (!this.jobs.isTerminal(current)) {
      const cancelled: JobRecord = {
        ...current,
        status: "cancelled",
        finished_at: new Date().toISOString(),
        error_code: "CANCELLED_BY_OPERATOR",
      };
      await this.jobs.write(cancelled);
      return cancelled;
    }
    return current;
  }

  async shutdown(): Promise<void> {
    const active = [...this.#active.entries()];
    await Promise.all(
      active.map(async ([jobId, fiber]) => {
        await Effect.runPromise(Fiber.interrupt(fiber));
        const current = await this.jobs.get(jobId).catch(() => undefined);
        if (current !== undefined && !this.jobs.isTerminal(current)) {
          await this.jobs.write({
            ...current,
            status: "interrupted",
            finished_at: new Date().toISOString(),
            error_code: "SERVICE_STOPPED",
          });
        }
      }),
    );
  }

  #execute(
    queued: JobRecord,
    provider: SandboxProvider,
    execution: ProviderExecution,
  ): Effect.Effect<void, never> {
    const jobs = this.jobs;
    const artifacts = this.artifacts;
    const program = Effect.gen(function* () {
      const running: JobRecord = {
        ...queued,
        status: "running",
        started_at: new Date().toISOString(),
      };
      yield* effectPromise(() => jobs.write(running), "Unable to persist running job state.");
      const result = yield* provider.run(execution);
      if (result.attestation.provider_attestation_id !== queued.provider_attestation_id) {
        return yield* Effect.fail(
          providerFailed("Provider execution attestation changed after admission."),
        );
      }
      const executionAttestation = yield* effectPromise(
        () =>
          artifacts.stage(
            encodeExecutionAttestation(result.attestation),
            "application/vnd.drone.execution-attestation+json",
          ),
        "Unable to preserve the execution attestation.",
      );
      const outputs: Array<JobOutputArtifact> = [];
      for (const output of result.outputs) {
        const metadata = yield* effectPromise(
          () => artifacts.stage(output.bytes, output.definition.media_type),
          "Unable to preserve a sandbox output.",
        );
        outputs.push({
          name: output.definition.name,
          artifact_id: metadata.artifact_id,
          size_bytes: metadata.size_bytes,
          media_type: metadata.media_type,
        });
      }
      let stdout: ArtifactMetadata | undefined;
      if (result.stdout.byteLength > 0) {
        stdout = yield* effectPromise(
          () => artifacts.stage(result.stdout, "text/plain"),
          "Unable to preserve sandbox stdout.",
        );
      }
      let stderr: ArtifactMetadata | undefined;
      if (result.stderr.byteLength > 0) {
        stderr = yield* effectPromise(
          () => artifacts.stage(result.stderr, "text/plain"),
          "Unable to preserve sandbox stderr.",
        );
      }
      const succeeded = result.exit_code === 0 && !result.timed_out;
      yield* effectPromise(
        () =>
          jobs.write({
            ...running,
            status: succeeded ? "succeeded" : "failed",
            outputs,
            finished_at: new Date().toISOString(),
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            ...(stdout === undefined ? {} : { stdout_artifact_id: stdout.artifact_id }),
            ...(stderr === undefined ? {} : { stderr_artifact_id: stderr.artifact_id }),
            execution_attestation_artifact_id: executionAttestation.artifact_id,
            ...(succeeded
              ? {}
              : { error_code: result.timed_out ? "SANDBOX_TIMEOUT" : "SANDBOX_EXIT_NONZERO" }),
          }),
        "Unable to persist terminal job state.",
      );
    });

    return program.pipe(
      Effect.catch((error) =>
        Effect.promise(async () => {
          const current = await jobs.get(queued.job_id).catch(() => queued);
          if (jobs.isTerminal(current)) return;
          await jobs.write({
            ...current,
            status: "failed",
            finished_at: new Date().toISOString(),
            error_code: error.code,
          });
        }),
      ),
    );
  }
}
