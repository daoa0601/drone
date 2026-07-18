import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AppleNativeProvider, buildNativeDriverRequest } from "../src/apple-native.js";
import {
  APPLE_NATIVE_ISOLATION_CLAIMS,
  createAppleNativeAttestationPayload,
  signProviderAttestation,
} from "../src/attestation.js";
import { decodeOperationRegistry } from "../src/contracts.js";
import type { ProviderExecution } from "../src/domain.js";
import { operation, temporaryDirectory } from "./helpers.js";

function testExecution(
  providerAttestationId = `attestation.sha256.${"a".repeat(64)}`,
): ProviderExecution {
  const definition = decodeOperationRegistry({
    schema_version: "1",
    operations: [operation()],
  })[0]!;
  return {
    job_id: "job_0123456789abcdef0123456789abcdef",
    provider_attestation_id: providerAttestationId,
    attestation_challenge: "d".repeat(64),
    operation: definition,
    inputs: [
      {
        slot: definition.inputs[0]!,
        metadata: {
          schema_version: "1",
          artifact_id: `sha256_${"b".repeat(64)}`,
          sha256: "b".repeat(64),
          size_bytes: 6,
          media_type: "application/octet-stream",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        bytes: Buffer.from("sample"),
      },
    ],
  };
}

function responseSource(overrides = ""): string {
  return String.raw`
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(body);
  process.stdout.write(JSON.stringify({
    protocol_version: "1",
    ok: true,
    exit_code: 0,
    timed_out: false,
    duration_ms: 1,
    stdout_base64: "",
    stderr_base64: "",
    outputs: [],
    attestation: {
      schema_version: "1",
      profile: "apple_native_no_network_vm_v1",
      provider_attestation_id: request.provider_attestation_id,
      challenge: request.attestation_challenge,
      container_id: request.container_id,
      image_reference: request.image_reference,
      backend: "apple_containerization",
      isolation: "lightweight_vm",
      guest_os: "linux",
      network_mode: "none",
      ephemeral_vm: true,
      read_only_root: true,
      input_disk_read_only: true,
      output_disk_bounded: true,
      host_directory_sharing: false,
      socket_sharing: false,
      nested_virtualization: false,
      non_root_required: true,
      no_new_privileges: true,
      capabilities: "none"
    },
    ${overrides}
  }));
});`;
}

async function provisionedProvider(
  driverSource: string,
  enabled = true,
): Promise<{ provider: AppleNativeProvider; runs: string; attestationId: string }> {
  const root = await temporaryDirectory("drone-apple-run-");
  const driver = path.join(root, "drone-sandboxd");
  const kernel = path.join(root, "vmlinux");
  const initfs = path.join(root, "vminit.ext4");
  const state = path.join(root, "state");
  const runs = path.join(root, "runs");
  const attestationFile = path.join(root, "attestation.json");
  const attestationPublicKey = path.join(root, "attestor.pub.pem");
  const probe = {
    protocol_version: "1",
    profile: "apple_native_no_network_vm_v1",
    ...APPLE_NATIVE_ISOLATION_CLAIMS,
  };
  const wrappedDriver = `
if (process.argv[2] === "probe") {
  process.stdout.write(${JSON.stringify(JSON.stringify(probe))});
  process.exit(0);
}
${driverSource}`;
  await Promise.all([
    writeFile(driver, `#!${process.execPath}\n${wrappedDriver}\n`),
    writeFile(kernel, "kernel"),
    writeFile(initfs, "init"),
    mkdir(state),
  ]);
  await chmod(driver, 0o700);
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const issuedAt = new Date();
  const payload = await createAppleNativeAttestationPayload({
    measurements: { driverPath: driver, kernelPath: kernel, initfsPath: initfs },
    issuer: "independent-test-attestor",
    issuedAt,
    expiresAt: new Date(issuedAt.valueOf() + 60 * 60 * 1000),
  });
  const attestation = signProviderAttestation({
    payload,
    privateKeyPem,
    publicKeyPem,
    now: issuedAt,
  });
  await Promise.all([
    writeFile(attestationFile, `${JSON.stringify(attestation)}\n`, { mode: 0o600 }),
    writeFile(attestationPublicKey, publicKeyPem, { mode: 0o600 }),
  ]);
  return {
    provider: new AppleNativeProvider({
      enabled,
      driverPath: driver,
      kernelPath: kernel,
      initfsPath: initfs,
      stateRoot: state,
      runsRoot: runs,
      attestationFile,
      attestationPublicKey,
      platform: "darwin",
      architecture: "arm64",
    }),
    runs,
    attestationId: attestation.attestation_id,
  };
}

describe("Apple native provider", () => {
  it("keeps network configuration out of the native request and emits fixed resource policy", () => {
    const execution = testExecution();
    const request = buildNativeDriverRequest(
      execution,
      {
        enabled: true,
        driverPath: "/opt/drone/drone-sandboxd",
        kernelPath: "/opt/drone/vmlinux",
        initfsPath: "/opt/drone/vminit.ext4",
        stateRoot: "/opt/drone/state",
        runsRoot: "/opt/drone/runs",
        attestationFile: "/opt/drone/attestation.json",
        attestationPublicKey: "/opt/drone/attestor.pub.pem",
      },
      "/opt/drone/runs/one",
    );
    expect(request).toMatchObject({
      protocol_version: "1",
      architecture: "arm64",
      uid: 65_532,
      writable_layer_bytes: 128 * 1024 * 1024,
    });
    expect(request).not.toHaveProperty("network");
    expect(request.command).toEqual(execution.operation.command);
    expect(request.inputs[0]?.host_path).toBe("/opt/drone/runs/one/inputs/sample");
  });

  it("reports ready only when the complete Apple runtime is present and enabled", async () => {
    const { provider, attestationId } = await provisionedProvider("process.exit(0);");
    await expect(provider.status()).resolves.toMatchObject({
      installed: true,
      enabled: true,
      mutations_available: true,
      attested: true,
      attestation: { attestation_id: attestationId },
      reason: "ready",
      network_modes: ["none"],
    });
  });

  it("reports the exact missing prerequisite and honors the enable switch", async () => {
    const root = await temporaryDirectory("drone-apple-prerequisites-");
    const options = {
      enabled: true,
      driverPath: path.join(root, "driver"),
      kernelPath: path.join(root, "kernel"),
      initfsPath: path.join(root, "initfs"),
      stateRoot: path.join(root, "state"),
      runsRoot: path.join(root, "runs"),
      attestationFile: path.join(root, "attestation.json"),
      attestationPublicKey: path.join(root, "attestor.pub.pem"),
      platform: "darwin" as const,
      architecture: "arm64",
    };

    await expect(
      new AppleNativeProvider({ ...options, platform: "linux" }).status(),
    ).resolves.toMatchObject({ reason: "unsupported_host" });
    await expect(new AppleNativeProvider(options).status()).resolves.toMatchObject({
      reason: "driver_not_installed",
    });
    await writeFile(options.driverPath, "driver");
    await chmod(options.driverPath, 0o700);
    await expect(new AppleNativeProvider(options).status()).resolves.toMatchObject({
      reason: "kernel_not_provisioned",
    });
    await writeFile(options.kernelPath, "kernel");
    await expect(new AppleNativeProvider(options).status()).resolves.toMatchObject({
      reason: "initfs_not_provisioned",
    });
    await writeFile(options.initfsPath, "init");
    await expect(new AppleNativeProvider(options).status()).resolves.toMatchObject({
      reason: "image_store_not_provisioned",
    });
    await mkdir(options.stateRoot);
    await expect(new AppleNativeProvider(options).status()).resolves.toMatchObject({
      installed: true,
      enabled: true,
      attested: false,
      mutations_available: false,
      reason: "attestation_missing_invalid_or_expired",
    });
    await expect(
      new AppleNativeProvider({ ...options, enabled: false }).status(),
    ).resolves.toMatchObject({
      installed: true,
      enabled: false,
      reason: "disabled_by_configuration",
    });
  });

  it("executes a provisioned shell-free driver and validates declared outputs", async () => {
    const source = String.raw`
const fs = require("node:fs");
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(body);
  const input = request.inputs[0].host_path;
  if (fs.readFileSync(input, "utf8") !== "sample") process.exit(11);
  if ((fs.statSync(input).mode & 0o222) !== 0) process.exit(12);
  if (!input.startsWith(request.work_root.replace(/\/native$/, "/inputs/"))) process.exit(13);
  fs.mkdirSync(request.output_directory, { recursive: true });
  const output = request.output_directory + "/report";
  const bytes = Buffer.from('{"verdict":"native-contract"}\n');
  fs.writeFileSync(output, bytes);
  process.stdout.write(JSON.stringify({
    protocol_version: "1",
    ok: true,
    exit_code: 0,
    timed_out: false,
    duration_ms: 7,
    stdout_base64: Buffer.from("complete\n").toString("base64"),
    stderr_base64: "",
    attestation: {
      schema_version: "1",
      profile: "apple_native_no_network_vm_v1",
      provider_attestation_id: request.provider_attestation_id,
      challenge: request.attestation_challenge,
      container_id: request.container_id,
      image_reference: request.image_reference,
      backend: "apple_containerization",
      isolation: "lightweight_vm",
      guest_os: "linux",
      network_mode: "none",
      ephemeral_vm: true,
      read_only_root: true,
      input_disk_read_only: true,
      output_disk_bounded: true,
      host_directory_sharing: false,
      socket_sharing: false,
      nested_virtualization: false,
      non_root_required: true,
      no_new_privileges: true,
      capabilities: "none"
    },
    outputs: [{ name: "report", host_path: output, size_bytes: bytes.length }]
  }));
});`;
    const { provider, runs, attestationId } = await provisionedProvider(source);

    const result = await Effect.runPromise(provider.run(testExecution(attestationId)));

    expect(result).toMatchObject({ exit_code: 0, timed_out: false, duration_ms: 7 });
    expect(Buffer.from(result.stdout).toString()).toBe("complete\n");
    expect(Buffer.from(result.outputs[0]!.bytes).toString()).toBe(
      '{"verdict":"native-contract"}\n',
    );
    await expect(readdir(runs)).resolves.toEqual([]);
  });

  it.each([
    ["non-zero driver exit", "process.exit(3);"],
    ["non-JSON response", 'process.stdout.write("not-json");'],
    [
      "invalid protocol response",
      'process.stdout.write(JSON.stringify({ protocol_version: "2", ok: true }));',
    ],
    ["invalid log encoding", responseSource('stdout_base64: "%%%",')],
    ["missing required output", responseSource()],
    [
      "output path escape",
      responseSource('outputs: [{ name: "report", host_path: "/tmp/escape", size_bytes: 1 }],'),
    ],
  ])("fails closed on %s", async (_label, source) => {
    const { provider, attestationId } = await provisionedProvider(source);
    await expect(
      Effect.runPromise(provider.run(testExecution(attestationId))),
    ).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
    });
  });

  it("rejects execution while the native provider is disabled", async () => {
    const { provider, attestationId } = await provisionedProvider("process.exit(0);", false);
    await expect(
      Effect.runPromise(provider.run(testExecution(attestationId))),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
