import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeJobSubmission } from "../src/contracts.js";
import type { ProviderStatus } from "../src/domain.js";
import { providerFailed } from "../src/errors.js";
import type { SandboxProvider } from "../src/provider.js";
import { DroneService } from "../src/service.js";
import { FakeAppleProvider, testConfig, writeRegistry } from "./helpers.js";

async function terminal(service: DroneService, jobId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await service.inspectJob(jobId);
    if (job.status !== "queued" && job.status !== "running") return job.status;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not finish");
}

describe("DroneService", () => {
  it("runs a trusted operation and preserves outputs as content-addressed artifacts", async () => {
    const config = await testConfig();
    await writeRegistry(config.operationsFile);
    const service = new DroneService(config, { providers: [new FakeAppleProvider()] });
    const input = await service.stageArtifact(Buffer.from("sample"), "application/octet-stream");
    const submitted = await service.submit(
      decodeJobSubmission({
        schema_version: "1",
        operation_id: "test.inspect",
        inputs: { sample: input.artifact_id },
      }),
    );
    expect(await terminal(service, submitted.job_id)).toBe("succeeded");
    const result = await service.inspectJob(submitted.job_id);
    expect(result).toMatchObject({
      status: "succeeded",
      exit_code: 0,
      outputs: [{ name: "report", media_type: "application/json" }],
      stdout_artifact_id: expect.stringMatching(/^sha256_[a-f0-9]{64}$/u),
    });
    await expect(service.listJobs()).resolves.toEqual([
      expect.objectContaining({ job_id: submitted.job_id }),
    ]);
    await expect(service.operations()).resolves.toEqual([
      expect.objectContaining({ operation_id: "test.inspect", network: "none" }),
    ]);
  });

  it("hands the provider immutable verified bytes instead of a reopenable CAS path", async () => {
    const config = await testConfig();
    await writeRegistry(config.operationsFile);
    let observed = "";
    const provider = new FakeAppleProvider((execution) =>
      Effect.promise(async () => {
        const input = execution.inputs[0]!;
        await writeFile(path.join(config.artifactRoot, "blobs", input.metadata.sha256), "evil");
        observed = input.bytes.toString("utf8");
        return {
          exit_code: 0,
          timed_out: false,
          duration_ms: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          outputs: [],
        };
      }),
    );
    const service = new DroneService(config, { providers: [provider] });
    const input = await service.stageArtifact(Buffer.from("sample"), "application/octet-stream");

    const job = await service.submit({
      schema_version: "1",
      operation_id: "test.inspect",
      inputs: { sample: input.artifact_id },
    });

    expect(await terminal(service, job.job_id)).toBe("succeeded");
    expect(observed).toBe("sample");
  });

  it("interrupts an active provider effect and records operator cancellation", async () => {
    const config = await testConfig();
    await writeRegistry(config.operationsFile);
    const service = new DroneService(config, {
      providers: [new FakeAppleProvider(() => Effect.never)],
    });
    const input = await service.stageArtifact(Buffer.from("sample"), "application/octet-stream");
    const job = await service.submit({
      schema_version: "1",
      operation_id: "test.inspect",
      inputs: { sample: input.artifact_id },
    });
    const cancelled = await service.cancel(job.job_id);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      error_code: "CANCELLED_BY_OPERATOR",
    });
  });

  it("enforces operation input declarations before reserving a sandbox", async () => {
    const config = await testConfig();
    await writeRegistry(config.operationsFile);
    const service = new DroneService(config, { providers: [new FakeAppleProvider()] });
    const binary = await service.stageArtifact(Buffer.from("sample"), "application/octet-stream");
    const text = await service.stageArtifact(Buffer.from("text"), "text/plain");

    await expect(
      service.submit({
        schema_version: "1",
        operation_id: "test.inspect",
        inputs: { unknown: binary.artifact_id },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.submit({ schema_version: "1", operation_id: "test.inspect", inputs: {} }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.submit({
        schema_version: "1",
        operation_id: "test.inspect",
        inputs: { sample: text.artifact_id },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(service.activeJobCount).toBe(0);
  });

  it("applies the global admission cap atomically", async () => {
    const config = await testConfig({ maxActiveJobs: 1 });
    await writeRegistry(config.operationsFile);
    const service = new DroneService(config, {
      providers: [new FakeAppleProvider(() => Effect.never)],
    });
    const input = await service.stageArtifact(Buffer.from("sample"), "application/octet-stream");
    const submission = {
      schema_version: "1" as const,
      operation_id: "test.inspect",
      inputs: { sample: input.artifact_id },
    };

    const active = await service.submit(submission);
    expect(service.activeJobCount).toBe(1);
    await expect(service.submit(submission)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await service.cancel(active.job_id);
  });

  it("rejects missing and unavailable providers", async () => {
    const config = await testConfig();
    await writeRegistry(config.operationsFile);
    const inputService = new DroneService(config, { providers: [] });
    const input = await inputService.stageArtifact(
      Buffer.from("sample"),
      "application/octet-stream",
    );
    const submission = {
      schema_version: "1" as const,
      operation_id: "test.inspect",
      inputs: { sample: input.artifact_id },
    };
    await expect(inputService.submit(submission)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });

    const status: ProviderStatus = {
      provider_id: "apple_native",
      product: "Unavailable provider",
      installed: false,
      enabled: false,
      mutations_available: false,
      reason: "not_ready",
      isolation: "lightweight_vm",
      guest_os: ["linux"],
      network_modes: ["none"],
    };
    const unavailable: SandboxProvider = {
      providerId: "apple_native",
      status: async () => status,
      run: () => Effect.die("unreachable"),
    };
    const service = new DroneService(config, { providers: [unavailable] });
    await expect(service.submit(submission)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("records provider errors, non-zero exits, timeouts, and stderr without leaking causes", async () => {
    const cases = [
      {
        run: () => Effect.fail(providerFailed("private provider detail")),
        expected: "PROVIDER_FAILED",
      },
      {
        run: () =>
          Effect.succeed({
            exit_code: 9,
            timed_out: false,
            duration_ms: 2,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("failure\n"),
            outputs: [],
          }),
        expected: "SANDBOX_EXIT_NONZERO",
      },
      {
        run: () =>
          Effect.succeed({
            exit_code: 124,
            timed_out: true,
            duration_ms: 30_000,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            outputs: [],
          }),
        expected: "SANDBOX_TIMEOUT",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const config = await testConfig();
      await writeRegistry(config.operationsFile);
      const service = new DroneService(config, {
        providers: [new FakeAppleProvider(testCase.run)],
      });
      const input = await service.stageArtifact(
        Buffer.from(`sample-${index}`),
        "application/octet-stream",
      );
      const job = await service.submit({
        schema_version: "1",
        operation_id: "test.inspect",
        inputs: { sample: input.artifact_id },
      });
      expect(await terminal(service, job.job_id)).toBe("failed");
      await expect(service.inspectJob(job.job_id)).resolves.toMatchObject({
        status: "failed",
        error_code: testCase.expected,
      });
    }
  });

  it("interrupts active jobs during service shutdown", async () => {
    const config = await testConfig();
    await writeRegistry(config.operationsFile);
    const service = new DroneService(config, {
      providers: [new FakeAppleProvider(() => Effect.never)],
    });
    const input = await service.stageArtifact(Buffer.from("sample"), "application/octet-stream");
    const job = await service.submit({
      schema_version: "1",
      operation_id: "test.inspect",
      inputs: { sample: input.artifact_id },
    });

    await service.shutdown();

    await expect(service.inspectJob(job.job_id)).resolves.toMatchObject({
      status: "interrupted",
      error_code: "SERVICE_STOPPED",
    });
    await expect(service.cancel(job.job_id)).rejects.toMatchObject({ code: "JOB_NOT_ACTIVE" });
  });
});
