import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";

import type { DroneConfig } from "../src/config.js";
import type { ProviderExecution, ProviderExecutionResult, ProviderStatus } from "../src/domain.js";
import type { DroneError } from "../src/errors.js";
import type { SandboxProvider } from "../src/provider.js";

export async function temporaryDirectory(prefix = "drone-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function testConfig(overrides: Partial<DroneConfig> = {}): Promise<DroneConfig> {
  const droneHome = overrides.droneHome ?? (await temporaryDirectory());
  return {
    host: "127.0.0.1",
    port: 0,
    droneHome,
    artifactRoot: path.join(droneHome, "artifacts"),
    jobsRoot: path.join(droneHome, "jobs"),
    runsRoot: path.join(droneHome, "runs"),
    operationsFile: path.join(droneHome, "operations.json"),
    maxActiveJobs: 2,
    maxJsonBytes: 64 * 1024,
    maxArtifactBytes: 4 * 1024 * 1024,
    appleNativeEnabled: false,
    appleNativeDriver: path.join(droneHome, "bin", "drone-sandboxd"),
    appleNativeKernel: path.join(droneHome, "runtime", "vmlinux-arm64"),
    appleNativeInitfs: path.join(droneHome, "runtime", "vminit.ext4"),
    appleNativeStateRoot: path.join(droneHome, "runtime", "state"),
    ...overrides,
  };
}

export function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: "test.inspect",
    enabled: true,
    provider: "apple_native",
    image: `registry.example/drone/tool@sha256:${"a".repeat(64)}`,
    command: ["/usr/local/bin/inspect", "/drone/input/sample", "/drone/output/report"],
    environment: {},
    architecture: "arm64",
    network: "none",
    uid: 65_532,
    gid: 65_532,
    inputs: [
      {
        name: "sample",
        required: true,
        max_bytes: 1024 * 1024,
        media_types: ["application/octet-stream"],
      },
    ],
    outputs: [
      {
        name: "report",
        required: true,
        max_bytes: 1024 * 1024,
        media_type: "application/json",
      },
    ],
    resources: {
      cpus: 1,
      memory_mb: 512,
      rootfs_mb: 1024,
      writable_mb: 128,
      output_disk_mb: 16,
      timeout_seconds: 30,
      max_log_bytes: 65_536,
      max_processes: 32,
      max_open_files: 128,
    },
    ...overrides,
  };
}

export async function writeRegistry(
  file: string,
  operations: ReadonlyArray<Record<string, unknown>> = [operation()],
): Promise<void> {
  await writeFile(file, `${JSON.stringify({ schema_version: "1", operations }, null, 2)}\n`, {
    mode: 0o600,
  });
}

export class FakeAppleProvider implements SandboxProvider {
  readonly providerId = "apple_native" as const;
  readonly #run: (
    execution: ProviderExecution,
  ) => Effect.Effect<ProviderExecutionResult, DroneError>;

  constructor(
    run: (
      execution: ProviderExecution,
    ) => Effect.Effect<ProviderExecutionResult, DroneError> = () =>
      Effect.succeed({
        exit_code: 0,
        timed_out: false,
        duration_ms: 12,
        stdout: Buffer.from("complete\n"),
        stderr: Buffer.alloc(0),
        outputs: [
          {
            definition: {
              name: "report",
              required: true,
              max_bytes: 1024 * 1024,
              media_type: "application/json",
            },
            bytes: Buffer.from('{"verdict":"bounded"}\n'),
          },
        ],
      }),
  ) {
    this.#run = run;
  }

  async status(): Promise<ProviderStatus> {
    return {
      provider_id: "apple_native",
      product: "Fake Apple Containerization",
      installed: true,
      enabled: true,
      mutations_available: true,
      reason: "ready",
      isolation: "lightweight_vm",
      guest_os: ["linux"],
      network_modes: ["none"],
    };
  }

  run(execution: ProviderExecution): Effect.Effect<ProviderExecutionResult, DroneError> {
    return this.#run(execution);
  }
}
