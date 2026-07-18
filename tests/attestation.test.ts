import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  APPLE_NATIVE_ISOLATION_CLAIMS,
  canonicalJson,
  createAppleNativeAttestationPayload,
  decodeProviderExecutionAttestation,
  providerAttestationSummary,
  readPrivateAttestationKey,
  signProviderAttestation,
  verifyAppleNativeAttestation,
} from "../src/attestation.js";
import { APPLE_NATIVE_ATTESTATION_PROFILE } from "../src/domain.js";
import { temporaryDirectory } from "./helpers.js";

async function fixture(): Promise<{
  readonly driver: string;
  readonly kernel: string;
  readonly initfs: string;
  readonly attestationFile: string;
  readonly publicKeyFile: string;
  readonly privateKeyFile: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly attestationId: string;
}> {
  const root = await temporaryDirectory("drone-attestation-");
  const driver = path.join(root, "drone-sandboxd");
  const kernel = path.join(root, "vmlinux");
  const initfs = path.join(root, "vminit.ext4");
  const attestationFile = path.join(root, "attestation.json");
  const publicKeyFile = path.join(root, "attestor.pub.pem");
  const privateKeyFile = path.join(root, "attestor.pem");
  const probe = {
    protocol_version: "1",
    profile: APPLE_NATIVE_ATTESTATION_PROFILE,
    ...APPLE_NATIVE_ISOLATION_CLAIMS,
  };
  await Promise.all([
    writeFile(
      driver,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(probe))});\n`,
      { mode: 0o700 },
    ),
    writeFile(kernel, "measured-kernel", { mode: 0o600 }),
    writeFile(initfs, "measured-initfs", { mode: 0o600 }),
    mkdir(path.join(root, "state")),
  ]);
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.valueOf() + 60 * 60 * 1000);
  const payload = await createAppleNativeAttestationPayload({
    measurements: { driverPath: driver, kernelPath: kernel, initfsPath: initfs },
    issuer: "separate-test-attestor",
    issuedAt,
    expiresAt,
  });
  const attestation = signProviderAttestation({
    payload,
    privateKeyPem,
    publicKeyPem,
    now: issuedAt,
  });
  await Promise.all([
    writeFile(attestationFile, `${JSON.stringify(attestation)}\n`, { mode: 0o600 }),
    writeFile(publicKeyFile, publicKeyPem, { mode: 0o600 }),
    writeFile(privateKeyFile, privateKeyPem, { mode: 0o600 }),
  ]);
  return {
    driver,
    kernel,
    initfs,
    attestationFile,
    publicKeyFile,
    privateKeyFile,
    issuedAt,
    expiresAt,
    attestationId: attestation.attestation_id,
  };
}

describe("independent Apple native attestation", () => {
  it("verifies a signed, current statement against exact runtime measurements and probe claims", async () => {
    const input = await fixture();
    const verified = await verifyAppleNativeAttestation({
      driverPath: input.driver,
      kernelPath: input.kernel,
      initfsPath: input.initfs,
      attestationFile: input.attestationFile,
      publicKeyFile: input.publicKeyFile,
      now: input.issuedAt,
    });
    expect(providerAttestationSummary(verified)).toMatchObject({
      attestation_id: input.attestationId,
      profile: APPLE_NATIVE_ATTESTATION_PROFILE,
      issuer: "separate-test-attestor",
    });
    expect(canonicalJson(verified.payload.claims)).toBe(
      canonicalJson(APPLE_NATIVE_ISOLATION_CLAIMS),
    );
  });

  it("fails closed after a measured asset changes, the trust key changes, or validity expires", async () => {
    const changed = await fixture();
    await writeFile(changed.kernel, "different-kernel", { mode: 0o600 });
    await expect(
      verifyAppleNativeAttestation({
        driverPath: changed.driver,
        kernelPath: changed.kernel,
        initfsPath: changed.initfs,
        attestationFile: changed.attestationFile,
        publicKeyFile: changed.publicKeyFile,
      }),
    ).rejects.toThrow(/measurements/iu);

    const untrusted = await fixture();
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    await writeFile(untrusted.publicKeyFile, other, { mode: 0o600 });
    await expect(
      verifyAppleNativeAttestation({
        driverPath: untrusted.driver,
        kernelPath: untrusted.kernel,
        initfsPath: untrusted.initfs,
        attestationFile: untrusted.attestationFile,
        publicKeyFile: untrusted.publicKeyFile,
      }),
    ).rejects.toThrow(/trusted|signature/iu);

    const expired = await fixture();
    await expect(
      verifyAppleNativeAttestation({
        driverPath: expired.driver,
        kernelPath: expired.kernel,
        initfsPath: expired.initfs,
        attestationFile: expired.attestationFile,
        publicKeyFile: expired.publicKeyFile,
        now: new Date(expired.expiresAt.valueOf() + 1),
      }),
    ).rejects.toThrow(/currently valid/iu);
  });

  it("binds per-job execution evidence to the admitted provider, challenge, VM, and image", () => {
    const expected = {
      providerAttestationId: `attestation.sha256.${"a".repeat(64)}`,
      challenge: "b".repeat(64),
      containerId: `drone-${"c".repeat(24)}`,
      imageReference: `registry.example/drone/tool@sha256:${"d".repeat(64)}`,
    };
    const value = {
      schema_version: "1",
      profile: APPLE_NATIVE_ATTESTATION_PROFILE,
      provider_attestation_id: expected.providerAttestationId,
      challenge: expected.challenge,
      container_id: expected.containerId,
      image_reference: expected.imageReference,
      ...APPLE_NATIVE_ISOLATION_CLAIMS,
    };
    expect(decodeProviderExecutionAttestation(value, expected)).toEqual(value);
    expect(() =>
      decodeProviderExecutionAttestation({ ...value, challenge: "e".repeat(64) }, expected),
    ).toThrow(/does not match/iu);
  });

  it("requires the offline signing key file to remain private and owned", async () => {
    const input = await fixture();
    await expect(readPrivateAttestationKey(input.privateKeyFile)).resolves.toBeInstanceOf(Buffer);
    await chmod(input.privateKeyFile, 0o644);
    await expect(readPrivateAttestationKey(input.privateKeyFile)).rejects.toThrow(/private/iu);
  });
});
