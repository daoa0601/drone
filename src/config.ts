import os from "node:os";
import path from "node:path";

import { invalidInput } from "./errors.js";

export interface DroneConfig {
  readonly host: string;
  readonly port: number;
  readonly droneHome: string;
  readonly artifactRoot: string;
  readonly jobsRoot: string;
  readonly runsRoot: string;
  readonly operationsFile: string;
  readonly bearerToken?: string;
  readonly maxActiveJobs: number;
  readonly maxJsonBytes: number;
  readonly maxArtifactBytes: number;
  readonly appleNativeEnabled: boolean;
  readonly appleNativeDriver: string;
  readonly appleNativeKernel: string;
  readonly appleNativeInitfs: string;
  readonly appleNativeStateRoot: string;
  readonly appleNativeAttestationFile: string;
  readonly appleNativeAttestationPublicKey: string;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidInput(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function boolean(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value.length === 0) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidInput(`${label} must be true or false.`);
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): DroneConfig {
  const host = environment.DRONE_HOST?.trim() || "127.0.0.1";
  const droneHome = path.resolve(
    environment.DRONE_HOME?.trim() || path.join(os.homedir(), ".drone"),
  );
  const token = environment.DRONE_BEARER_TOKEN?.trim();
  if (!isLoopbackHost(host) && !token) {
    throw invalidInput("DRONE_BEARER_TOKEN is required when DRONE_HOST is not loopback.");
  }
  return {
    host,
    port: integer(environment.DRONE_PORT, 8090, 1, 65_535, "DRONE_PORT"),
    droneHome,
    artifactRoot: path.join(droneHome, "artifacts"),
    jobsRoot: path.join(droneHome, "jobs"),
    runsRoot: path.join(droneHome, "runs"),
    operationsFile: path.resolve(
      environment.DRONE_OPERATIONS_FILE?.trim() || path.join(droneHome, "operations.json"),
    ),
    ...(token === undefined || token.length === 0 ? {} : { bearerToken: token }),
    maxActiveJobs: integer(environment.DRONE_MAX_ACTIVE_JOBS, 2, 1, 32, "DRONE_MAX_ACTIVE_JOBS"),
    maxJsonBytes: integer(
      environment.DRONE_MAX_JSON_BYTES,
      64 * 1024,
      1024,
      1024 * 1024,
      "DRONE_MAX_JSON_BYTES",
    ),
    maxArtifactBytes: integer(
      environment.DRONE_MAX_ARTIFACT_BYTES,
      256 * 1024 * 1024,
      1024,
      1024 * 1024 * 1024,
      "DRONE_MAX_ARTIFACT_BYTES",
    ),
    appleNativeEnabled: boolean(
      environment.DRONE_APPLE_NATIVE_ENABLED,
      false,
      "DRONE_APPLE_NATIVE_ENABLED",
    ),
    appleNativeDriver: path.resolve(
      environment.DRONE_APPLE_NATIVE_DRIVER?.trim() ||
        path.join(droneHome, "bin", "drone-sandboxd"),
    ),
    appleNativeKernel: path.resolve(
      environment.DRONE_APPLE_NATIVE_KERNEL?.trim() ||
        path.join(droneHome, "runtime", "vmlinux-arm64"),
    ),
    appleNativeInitfs: path.resolve(
      environment.DRONE_APPLE_NATIVE_INITFS?.trim() ||
        path.join(droneHome, "runtime", "vminit.ext4"),
    ),
    appleNativeStateRoot: path.resolve(
      environment.DRONE_APPLE_NATIVE_STATE?.trim() || path.join(droneHome, "runtime", "state"),
    ),
    appleNativeAttestationFile: path.resolve(
      environment.DRONE_APPLE_NATIVE_ATTESTATION?.trim() ||
        path.join(droneHome, "runtime", "apple-native-attestation.json"),
    ),
    appleNativeAttestationPublicKey: path.resolve(
      environment.DRONE_APPLE_NATIVE_ATTESTATION_PUBLIC_KEY?.trim() ||
        path.join(droneHome, "runtime", "apple-native-attestor.pub.pem"),
    ),
  };
}
