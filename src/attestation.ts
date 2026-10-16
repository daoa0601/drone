import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import {
  APPLE_NATIVE_PROVIDER_ID,
  isDroneAttestationChallenge,
  isDroneAttestationId,
  isDroneAttestationKeyId,
  isDroneContainerId,
  isDroneImageReference,
} from "@agentic-orch/drone-client";
import { Effect } from "effect";

import {
  APPLE_NATIVE_ATTESTATION_PROFILE,
  type AppleNativeAttestationPayload,
  type AppleNativeIsolationClaims,
  type ProviderAttestationSummary,
  type ProviderExecutionAttestation,
  type SignedProviderAttestation,
} from "./domain.js";
import { runProcess } from "./process.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_ATTESTATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const APPLE_NATIVE_ISOLATION_CLAIMS: AppleNativeIsolationClaims = Object.freeze({
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
  capabilities: "none",
});

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface AppleNativeMeasurementOptions {
  readonly driverPath: string;
  readonly kernelPath: string;
  readonly initfsPath: string;
}

export interface AppleNativeAttestationVerificationOptions extends AppleNativeMeasurementOptions {
  readonly attestationFile: string;
  readonly publicKeyFile: string;
  readonly now?: Date;
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, expected: ReadonlyArray<string>, label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} does not match its strict schema.`);
  }
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  const unsafeControl =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    });
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || unsafeControl) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return timestamp;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON cannot contain a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortedJsonValue(entry)]),
    );
  }
  throw new Error("Canonical JSON contains an unsupported value.");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

async function stableFileBytes(file: string, maximum: number): Promise<Buffer> {
  const handle = await open(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size <= 0n ||
      before.size > BigInt(maximum) ||
      (before.mode & 0o022n) !== 0n
    ) {
      throw new Error("Attestation material is not a bounded, non-writable regular file.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(bytes.byteLength) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Attestation material changed while it was read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readPrivateAttestationKey(file: string): Promise<Buffer> {
  const handle = await open(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const expectedUid =
      typeof process.geteuid === "function" ? BigInt(process.geteuid()) : before.uid;
    if (
      !before.isFile() ||
      before.size <= 0n ||
      before.size > BigInt(MAX_PUBLIC_KEY_BYTES) ||
      before.uid !== expectedUid ||
      (before.mode & 0o077n) !== 0n
    ) {
      throw new Error("Attestation private key must be a private, owned regular file.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(bytes.byteLength) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Attestation private key changed while it was read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readPublicAttestationKey(file: string): Promise<Buffer> {
  return stableFileBytes(file, MAX_PUBLIC_KEY_BYTES);
}

export async function readAttestationDocument(file: string): Promise<Buffer> {
  return stableFileBytes(file, MAX_ATTESTATION_BYTES);
}

export async function sha256RegularFile(file: string, executable = false): Promise<string> {
  const handle = await open(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size <= 0n ||
      (before.mode & 0o022n) !== 0n ||
      (executable && (before.mode & 0o111n) === 0n)
    ) {
      throw new Error("Measured runtime asset is not a safe regular file.");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("Measured runtime asset changed while it was hashed.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function decodeClaims(value: unknown, label: string): AppleNativeIsolationClaims {
  const claims = record(value, label);
  exactKeys(claims, Object.keys(APPLE_NATIVE_ISOLATION_CLAIMS), label);
  for (const [key, expected] of Object.entries(APPLE_NATIVE_ISOLATION_CLAIMS)) {
    if (claims[key] !== expected) throw new Error(`${label}.${key} is not the required invariant.`);
  }
  return APPLE_NATIVE_ISOLATION_CLAIMS;
}

function validatePayloadTime(payload: AppleNativeAttestationPayload, now: Date): void {
  const issued = new Date(payload.issued_at).valueOf();
  const expires = new Date(payload.expires_at).valueOf();
  const current = now.valueOf();
  if (
    issued > current + MAX_CLOCK_SKEW_MS ||
    expires <= current ||
    expires <= issued ||
    expires - issued > MAX_ATTESTATION_LIFETIME_MS
  ) {
    throw new Error("Provider attestation is not currently valid or exceeds seven days.");
  }
}

export function decodeAppleNativeAttestationPayload(
  value: unknown,
  now = new Date(),
): AppleNativeAttestationPayload {
  const payload = record(value, "attestation payload");
  exactKeys(
    payload,
    [
      "schema_version",
      "profile",
      "provider_id",
      "issuer",
      "issued_at",
      "expires_at",
      "measurements",
      "claims",
    ],
    "attestation payload",
  );
  if (
    payload.schema_version !== "1" ||
    payload.profile !== APPLE_NATIVE_ATTESTATION_PROFILE ||
    payload.provider_id !== APPLE_NATIVE_PROVIDER_ID
  ) {
    throw new Error("Attestation payload identity is invalid.");
  }
  const measurements = record(payload.measurements, "attestation measurements");
  exactKeys(
    measurements,
    ["driver_sha256", "kernel_sha256", "initfs_sha256"],
    "attestation measurements",
  );
  for (const [key, value] of Object.entries(measurements)) {
    if (typeof value !== "string" || !SHA256.test(value)) {
      throw new Error(`attestation measurements.${key} is invalid.`);
    }
  }
  const decoded: AppleNativeAttestationPayload = {
    schema_version: "1",
    profile: APPLE_NATIVE_ATTESTATION_PROFILE,
    provider_id: APPLE_NATIVE_PROVIDER_ID,
    issuer: boundedString(payload.issuer, "attestation issuer", 128),
    issued_at: canonicalTimestamp(payload.issued_at, "attestation issued_at"),
    expires_at: canonicalTimestamp(payload.expires_at, "attestation expires_at"),
    measurements: {
      driver_sha256: measurements.driver_sha256 as string,
      kernel_sha256: measurements.kernel_sha256 as string,
      initfs_sha256: measurements.initfs_sha256 as string,
    },
    claims: decodeClaims(payload.claims, "attestation claims"),
  };
  validatePayloadTime(decoded, now);
  return decoded;
}

function publicKeyId(publicKey: ReturnType<typeof createPublicKey>): string {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Provider attestation key must be Ed25519.");
  }
  const der = publicKey.export({ type: "spki", format: "der" });
  return `ed25519.sha256.${digest(der)}`;
}

function attestationId(payload: AppleNativeAttestationPayload): string {
  return `attestation.sha256.${digest(canonicalJson(payload))}`;
}

export function decodeSignedProviderAttestation(
  value: unknown,
  now = new Date(),
): SignedProviderAttestation {
  const envelope = record(value, "provider attestation");
  exactKeys(
    envelope,
    ["schema_version", "attestation_id", "key_id", "payload", "signature"],
    "provider attestation",
  );
  if (envelope.schema_version !== "1") throw new Error("Provider attestation version is invalid.");
  const payload = decodeAppleNativeAttestationPayload(envelope.payload, now);
  const decoded: SignedProviderAttestation = {
    schema_version: "1",
    attestation_id: boundedString(envelope.attestation_id, "attestation_id", 128),
    key_id: boundedString(envelope.key_id, "attestation key_id", 128),
    payload,
    signature: boundedString(envelope.signature, "attestation signature", 256),
  };
  if (
    !isDroneAttestationId(decoded.attestation_id) ||
    decoded.attestation_id !== attestationId(payload)
  ) {
    throw new Error("Provider attestation ID is invalid.");
  }
  if (!isDroneAttestationKeyId(decoded.key_id))
    throw new Error("Provider attestation key ID is invalid.");
  const signature = Buffer.from(decoded.signature, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== decoded.signature) {
    throw new Error("Provider attestation signature encoding is invalid.");
  }
  return decoded;
}

async function probeNativeDriver(driverPath: string): Promise<AppleNativeIsolationClaims> {
  const result = await Effect.runPromise(
    runProcess({
      executable: path.resolve(driverPath),
      args: ["probe"],
      stdin: "",
      cwd: path.dirname(path.resolve(driverPath)),
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    }),
  );
  if (result.exitCode !== 0 || result.stderr.byteLength !== 0) {
    throw new Error("Native driver probe failed.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error("Native driver probe did not return JSON.", { cause });
  }
  const probe = record(parsed, "native driver probe");
  exactKeys(
    probe,
    ["protocol_version", "profile", ...Object.keys(APPLE_NATIVE_ISOLATION_CLAIMS)],
    "native driver probe",
  );
  if (probe.protocol_version !== "1" || probe.profile !== APPLE_NATIVE_ATTESTATION_PROFILE) {
    throw new Error("Native driver probe identity is invalid.");
  }
  return decodeClaims(
    Object.fromEntries(Object.keys(APPLE_NATIVE_ISOLATION_CLAIMS).map((key) => [key, probe[key]])),
    "native driver probe claims",
  );
}

export async function createAppleNativeAttestationPayload(options: {
  readonly measurements: AppleNativeMeasurementOptions;
  readonly issuer: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}): Promise<AppleNativeAttestationPayload> {
  const claims = await probeNativeDriver(options.measurements.driverPath);
  return decodeAppleNativeAttestationPayload(
    {
      schema_version: "1",
      profile: APPLE_NATIVE_ATTESTATION_PROFILE,
      provider_id: APPLE_NATIVE_PROVIDER_ID,
      issuer: options.issuer,
      issued_at: options.issuedAt.toISOString(),
      expires_at: options.expiresAt.toISOString(),
      measurements: {
        driver_sha256: await sha256RegularFile(options.measurements.driverPath, true),
        kernel_sha256: await sha256RegularFile(options.measurements.kernelPath),
        initfs_sha256: await sha256RegularFile(options.measurements.initfsPath),
      },
      claims,
    },
    options.issuedAt,
  );
}

export function signProviderAttestation(options: {
  readonly payload: AppleNativeAttestationPayload;
  readonly privateKeyPem: string | Buffer;
  readonly publicKeyPem: string | Buffer;
  readonly now?: Date;
}): SignedProviderAttestation {
  const payload = decodeAppleNativeAttestationPayload(options.payload, options.now ?? new Date());
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKey = createPublicKey(options.publicKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Provider attestation signing key must be Ed25519.");
  }
  const bytes = Buffer.from(canonicalJson(payload));
  const signature = cryptoSign(null, bytes, privateKey);
  if (!cryptoVerify(null, bytes, publicKey, signature)) {
    throw new Error("Provider attestation private and public keys do not match.");
  }
  return {
    schema_version: "1",
    attestation_id: attestationId(payload),
    key_id: publicKeyId(publicKey),
    payload,
    signature: signature.toString("base64"),
  };
}

export async function verifyAppleNativeAttestation(
  options: AppleNativeAttestationVerificationOptions,
): Promise<SignedProviderAttestation> {
  const now = options.now ?? new Date();
  const [attestationBytes, publicKeyBytes] = await Promise.all([
    stableFileBytes(options.attestationFile, MAX_ATTESTATION_BYTES),
    stableFileBytes(options.publicKeyFile, MAX_PUBLIC_KEY_BYTES),
  ]);
  let value: unknown;
  try {
    value = JSON.parse(attestationBytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error("Provider attestation is not JSON.", { cause });
  }
  const attestation = decodeSignedProviderAttestation(value, now);
  const publicKey = createPublicKey(publicKeyBytes);
  if (attestation.key_id !== publicKeyId(publicKey)) {
    throw new Error("Provider attestation key is not trusted.");
  }
  if (
    !cryptoVerify(
      null,
      Buffer.from(canonicalJson(attestation.payload)),
      publicKey,
      Buffer.from(attestation.signature, "base64"),
    )
  ) {
    throw new Error("Provider attestation signature is invalid.");
  }
  const [driver, kernel, initfs, claims] = await Promise.all([
    sha256RegularFile(options.driverPath, true),
    sha256RegularFile(options.kernelPath),
    sha256RegularFile(options.initfsPath),
    probeNativeDriver(options.driverPath),
  ]);
  if (
    driver !== attestation.payload.measurements.driver_sha256 ||
    kernel !== attestation.payload.measurements.kernel_sha256 ||
    initfs !== attestation.payload.measurements.initfs_sha256 ||
    canonicalJson(claims) !== canonicalJson(attestation.payload.claims)
  ) {
    throw new Error("Provider runtime measurements do not match the signed attestation.");
  }
  return attestation;
}

export function providerAttestationSummary(
  attestation: SignedProviderAttestation,
): ProviderAttestationSummary {
  return {
    attestation_id: attestation.attestation_id,
    profile: attestation.payload.profile,
    key_id: attestation.key_id,
    issuer: attestation.payload.issuer,
    issued_at: attestation.payload.issued_at,
    expires_at: attestation.payload.expires_at,
  };
}

export function decodeProviderExecutionAttestation(
  value: unknown,
  expected: {
    readonly providerAttestationId: string;
    readonly challenge: string;
    readonly containerId: string;
    readonly imageReference: string;
  },
): ProviderExecutionAttestation {
  const attestation = record(value, "execution attestation");
  exactKeys(
    attestation,
    [
      "schema_version",
      "profile",
      "provider_attestation_id",
      "challenge",
      "container_id",
      "image_reference",
      ...Object.keys(APPLE_NATIVE_ISOLATION_CLAIMS),
    ],
    "execution attestation",
  );
  if (
    attestation.schema_version !== "1" ||
    attestation.profile !== APPLE_NATIVE_ATTESTATION_PROFILE ||
    typeof attestation.provider_attestation_id !== "string" ||
    !isDroneAttestationId(attestation.provider_attestation_id) ||
    typeof attestation.challenge !== "string" ||
    !isDroneAttestationChallenge(attestation.challenge) ||
    typeof attestation.container_id !== "string" ||
    !isDroneContainerId(attestation.container_id) ||
    typeof attestation.image_reference !== "string" ||
    !isDroneImageReference(attestation.image_reference)
  ) {
    throw new Error("Execution attestation identity is invalid.");
  }
  if (
    attestation.provider_attestation_id !== expected.providerAttestationId ||
    attestation.challenge !== expected.challenge ||
    attestation.container_id !== expected.containerId ||
    attestation.image_reference !== expected.imageReference
  ) {
    throw new Error("Execution attestation does not match the admitted job.");
  }
  const claims = decodeClaims(
    Object.fromEntries(
      Object.keys(APPLE_NATIVE_ISOLATION_CLAIMS).map((key) => [key, attestation[key]]),
    ),
    "execution attestation claims",
  );
  return {
    schema_version: "1",
    profile: APPLE_NATIVE_ATTESTATION_PROFILE,
    provider_attestation_id: attestation.provider_attestation_id,
    challenge: attestation.challenge,
    container_id: attestation.container_id,
    image_reference: attestation.image_reference,
    ...claims,
  };
}

export function encodeExecutionAttestation(value: ProviderExecutionAttestation): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}
