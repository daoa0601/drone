import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { DRONE_PROTOCOL_VERSION } from "./domain.js";
import type {
  NativeDriverRequest,
  OperationOutput,
  ProviderExecution,
  ProviderExecutionResult,
  ProviderOutput,
  ProviderStatus,
} from "./domain.js";
import { DroneError, providerFailed, serviceUnavailable } from "./errors.js";
import { runProcess } from "./process.js";
import type { SandboxProvider } from "./provider.js";

const MIB = 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface AppleNativeOptions {
  readonly enabled: boolean;
  readonly driverPath: string;
  readonly kernelPath: string;
  readonly initfsPath: string;
  readonly stateRoot: string;
  readonly runsRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

interface NativeSuccess {
  readonly protocol_version: "1";
  readonly ok: true;
  readonly exit_code: number;
  readonly timed_out: boolean;
  readonly duration_ms: number;
  readonly stdout_base64: string;
  readonly stderr_base64: string;
  readonly outputs: ReadonlyArray<{
    readonly name: string;
    readonly host_path: string;
    readonly size_bytes: number;
  }>;
}

async function regularFile(file: string, executable = false): Promise<boolean> {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink() && (!executable || (info.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

async function directory(value: string): Promise<boolean> {
  try {
    const info = await lstat(value);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function privateDirectory(value: string): Promise<boolean> {
  try {
    const info = await lstat(value);
    const owned = typeof process.geteuid !== "function" || info.uid === process.geteuid();
    return info.isDirectory() && !info.isSymbolicLink() && owned && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function nativeContainerId(jobId: string): string {
  return `drone-${createHash("sha256").update(jobId).digest("hex").slice(0, 24)}`;
}

export function buildNativeDriverRequest(
  execution: ProviderExecution,
  options: AppleNativeOptions,
  runRoot: string,
): NativeDriverRequest {
  const resources = execution.operation.resources;
  const environment = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
    ...execution.operation.environment,
  };
  return {
    protocol_version: DRONE_PROTOCOL_VERSION,
    container_id: nativeContainerId(execution.job_id),
    image_reference: execution.operation.image,
    image_store_root: path.resolve(options.stateRoot),
    kernel_path: path.resolve(options.kernelPath),
    initfs_path: path.resolve(options.initfsPath),
    work_root: path.join(runRoot, "native"),
    output_directory: path.join(runRoot, "outputs"),
    command: execution.operation.command,
    environment: Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`),
    architecture: execution.operation.architecture,
    uid: execution.operation.uid,
    gid: execution.operation.gid,
    cpus: resources.cpus,
    memory_bytes: resources.memory_mb * MIB,
    rootfs_bytes: resources.rootfs_mb * MIB,
    writable_layer_bytes: resources.writable_mb * MIB,
    output_disk_bytes: resources.output_disk_mb * MIB,
    timeout_seconds: resources.timeout_seconds,
    max_log_bytes: resources.max_log_bytes,
    max_processes: resources.max_processes,
    max_open_files: resources.max_open_files,
    inputs: execution.inputs.map((input) => ({
      name: input.slot.name,
      host_path: path.join(runRoot, "inputs", input.slot.name),
      sha256: input.metadata.sha256,
      size_bytes: input.metadata.size_bytes,
    })),
    outputs: execution.operation.outputs.map((output) => ({
      name: output.name,
      required: output.required,
      max_bytes: output.max_bytes,
    })),
  };
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function decodeSuccess(value: unknown): NativeSuccess {
  if (typeof value !== "object" || value === null) throw providerFailed("Invalid driver response.");
  const response = value as Partial<NativeSuccess> & { readonly ok?: unknown };
  if (
    response.protocol_version !== DRONE_PROTOCOL_VERSION ||
    response.ok !== true ||
    !integer(response.exit_code, 0, 255) ||
    typeof response.timed_out !== "boolean" ||
    !integer(response.duration_ms, 0, Number.MAX_SAFE_INTEGER) ||
    typeof response.stdout_base64 !== "string" ||
    typeof response.stderr_base64 !== "string" ||
    !Array.isArray(response.outputs)
  ) {
    throw providerFailed("Invalid driver response.");
  }
  return response as NativeSuccess;
}

function decodeBase64(value: string, maximum: number): Buffer {
  if (!BASE64.test(value)) throw providerFailed("Invalid driver log encoding.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maximum) throw providerFailed("Driver log exceeded its declared limit.");
  if (decoded.toString("base64") !== value) throw providerFailed("Invalid driver log encoding.");
  return decoded;
}

async function readOutputs(
  response: NativeSuccess,
  definitions: ReadonlyArray<OperationOutput>,
  outputDirectory: string,
): Promise<ReadonlyArray<ProviderOutput>> {
  const expected = new Map(definitions.map((definition) => [definition.name, definition]));
  const seen = new Set<string>();
  const outputs: Array<ProviderOutput> = [];
  for (const raw of response.outputs) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof raw.name !== "string" ||
      typeof raw.host_path !== "string" ||
      !integer(raw.size_bytes, 0, 256 * MIB)
    ) {
      throw providerFailed("Driver returned invalid output metadata.");
    }
    const definition = expected.get(raw.name);
    if (definition === undefined || seen.has(raw.name)) {
      throw providerFailed("Driver returned an undeclared or duplicate output.");
    }
    seen.add(raw.name);
    const exactPath = path.join(outputDirectory, raw.name);
    if (path.resolve(raw.host_path) !== exactPath) {
      throw providerFailed("Driver returned an output outside its run directory.");
    }
    const info = await lstat(exactPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== raw.size_bytes ||
      info.size > definition.max_bytes
    ) {
      throw providerFailed("Driver output violated its declaration.");
    }
    outputs.push({ definition, bytes: await readFile(exactPath) });
  }
  for (const definition of definitions) {
    if (definition.required && !seen.has(definition.name)) {
      throw providerFailed("Driver omitted a required output.");
    }
  }
  return outputs;
}

export class AppleNativeProvider implements SandboxProvider {
  readonly providerId = "apple_native" as const;
  readonly #options: AppleNativeOptions;

  constructor(options: AppleNativeOptions) {
    this.#options = {
      ...options,
      driverPath: path.resolve(options.driverPath),
      kernelPath: path.resolve(options.kernelPath),
      initfsPath: path.resolve(options.initfsPath),
      stateRoot: path.resolve(options.stateRoot),
      runsRoot: path.resolve(options.runsRoot),
    };
  }

  async status(): Promise<ProviderStatus> {
    const platform = this.#options.platform ?? process.platform;
    const architecture = this.#options.architecture ?? process.arch;
    const supportedHost = platform === "darwin" && architecture === "arm64";
    const driver = supportedHost && (await regularFile(this.#options.driverPath, true));
    const kernel = supportedHost && (await regularFile(this.#options.kernelPath));
    const initfs = supportedHost && (await regularFile(this.#options.initfsPath));
    const state = supportedHost && (await directory(this.#options.stateRoot));
    const installed = supportedHost && driver && kernel && initfs && state;
    const enabled = this.#options.enabled && installed;
    const reason = !supportedHost
      ? "unsupported_host"
      : !driver
        ? "driver_not_installed"
        : !kernel
          ? "kernel_not_provisioned"
          : !initfs
            ? "initfs_not_provisioned"
            : !state
              ? "image_store_not_provisioned"
              : !this.#options.enabled
                ? "disabled_by_configuration"
                : "ready";
    return {
      provider_id: "apple_native",
      product: "Apple Containerization",
      installed,
      enabled,
      mutations_available: enabled,
      reason,
      isolation: "lightweight_vm",
      guest_os: ["linux"],
      network_modes: ["none"],
    };
  }

  run(execution: ProviderExecution): Effect.Effect<ProviderExecutionResult, DroneError> {
    const acquire = Effect.tryPromise({
      try: async () => {
        const status = await this.status();
        if (!status.mutations_available) {
          throw serviceUnavailable("Apple native provider is not ready.");
        }
        await mkdir(this.#options.runsRoot, { recursive: true, mode: 0o700 });
        if (!(await privateDirectory(this.#options.runsRoot))) {
          throw serviceUnavailable("Native runs root must be a private owned directory.");
        }
        const runRoot = await mkdtemp(path.join(this.#options.runsRoot, "apple-native-"));
        if (!(await privateDirectory(runRoot))) {
          throw serviceUnavailable("Unable to establish private native run custody.");
        }
        return runRoot;
      },
      catch: (cause) =>
        cause instanceof DroneError
          ? cause
          : serviceUnavailable("Unable to allocate a native run directory.", cause),
    });
    return Effect.scoped(
      Effect.acquireRelease(acquire, (runRoot) =>
        Effect.promise(async () => {
          await chmod(path.join(runRoot, "inputs"), 0o700).catch(() => undefined);
          await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
        }),
      ).pipe(Effect.flatMap((runRoot) => this.#runInRoot(execution, runRoot))),
    );
  }

  #runInRoot(
    execution: ProviderExecution,
    runRoot: string,
  ): Effect.Effect<ProviderExecutionResult, DroneError> {
    const request = buildNativeDriverRequest(execution, this.#options, runRoot);
    return Effect.tryPromise({
      try: async () => {
        const inputDirectory = path.join(runRoot, "inputs");
        await mkdir(inputDirectory, { mode: 0o700 });
        for (const input of execution.inputs) {
          const destination = path.join(inputDirectory, input.slot.name);
          await writeFile(destination, input.bytes, { flag: "wx", mode: 0o400 });
        }
        // The native driver inherently consumes paths. Keep its inputs in a unique 0700 run root,
        // remove directory write permission after publication, and retain them only for the scoped
        // provider execution. The same effective UID remains the residual trust boundary.
        await chmod(inputDirectory, 0o500);
        await mkdir(request.work_root, { recursive: true, mode: 0o700 });
        await mkdir(request.output_directory, { recursive: true, mode: 0o700 });
      },
      catch: (cause) => providerFailed("Unable to prepare the native run.", cause),
    }).pipe(
      Effect.flatMap(() =>
        runProcess({
          executable: this.#options.driverPath,
          args: ["run"],
          stdin: `${JSON.stringify(request)}\n`,
          cwd: runRoot,
          env: {
            LANG: "C.UTF-8",
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            TMPDIR: request.work_root,
          },
          timeoutMs: (execution.operation.resources.timeout_seconds + 60) * 1000,
          maxOutputBytes: Math.max(512 * 1024, execution.operation.resources.max_log_bytes * 4),
        }),
      ),
      Effect.flatMap((processResult) =>
        Effect.tryPromise({
          try: async () => {
            if (processResult.exitCode !== 0) {
              throw providerFailed("Native driver rejected or failed the sandbox job.");
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(processResult.stdout.toString("utf8")) as unknown;
            } catch (cause) {
              throw providerFailed("Native driver did not return JSON.", cause);
            }
            const response = decodeSuccess(parsed);
            const maximum = execution.operation.resources.max_log_bytes;
            return {
              exit_code: response.exit_code,
              timed_out: response.timed_out,
              duration_ms: response.duration_ms,
              stdout: decodeBase64(response.stdout_base64, maximum),
              stderr: decodeBase64(response.stderr_base64, maximum),
              outputs: await readOutputs(
                response,
                execution.operation.outputs,
                request.output_directory,
              ),
            } satisfies ProviderExecutionResult;
          },
          catch: (cause) =>
            cause instanceof DroneError
              ? cause
              : providerFailed("Unable to validate native driver output.", cause),
        }),
      ),
    );
  }
}
