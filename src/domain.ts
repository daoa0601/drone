import type {
  APPLE_NATIVE_ATTESTATION_PROFILE,
  APPLE_NATIVE_PROVIDER_ID,
  DroneArtifactMetadata,
  DroneExecutionAttestation,
  DroneJob,
  DroneJobOutputArtifact,
  DroneJobStatus,
  DroneJobSubmission,
  DroneOperationInputSlot,
  DroneOperationOutput,
  DroneOperationResources,
  DroneProviderAttestationSummary,
  DroneProviderStatus,
  DronePublicOperation,
} from "@agentic-orch/drone-client";

// The public v1 wire contract lives in @agentic-orch/drone-client. These names keep the server's
// vocabulary and narrow the provider to the one this server implements.
export {
  APPLE_NATIVE_ATTESTATION_PROFILE,
  APPLE_NATIVE_PROVIDER_ID,
  DRONE_PROTOCOL_VERSION,
} from "@agentic-orch/drone-client";

export type ProviderId = typeof APPLE_NATIVE_PROVIDER_ID;
export type JobStatus = DroneJobStatus;
export type ProviderAttestationProfile = typeof APPLE_NATIVE_ATTESTATION_PROFILE;
export type ProviderAttestationSummary = DroneProviderAttestationSummary;
export type ProviderExecutionAttestation = DroneExecutionAttestation;
export type AppleNativeIsolationClaims = Omit<
  DroneExecutionAttestation,
  | "schema_version"
  | "profile"
  | "provider_attestation_id"
  | "challenge"
  | "container_id"
  | "image_reference"
>;
export type OperationInputSlot = DroneOperationInputSlot;
export type OperationOutput = DroneOperationOutput;
export type OperationResources = DroneOperationResources;
export type JobSubmission = DroneJobSubmission;
export type ArtifactMetadata = DroneArtifactMetadata;
export type JobOutputArtifact = DroneJobOutputArtifact;

export interface PublicOperation extends DronePublicOperation {
  readonly provider: ProviderId;
}

export interface JobRecord extends DroneJob {
  readonly provider_id: ProviderId;
}

export interface ProviderStatus extends DroneProviderStatus {
  readonly provider_id: ProviderId;
}

// Server-only types: trusted configuration, signed attestation statements, and the native driver.

export interface AppleNativeAttestationPayload {
  readonly schema_version: "1";
  readonly profile: ProviderAttestationProfile;
  readonly provider_id: ProviderId;
  readonly issuer: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly measurements: {
    readonly driver_sha256: string;
    readonly kernel_sha256: string;
    readonly initfs_sha256: string;
  };
  readonly claims: AppleNativeIsolationClaims;
}

export interface SignedProviderAttestation {
  readonly schema_version: "1";
  readonly attestation_id: string;
  readonly key_id: string;
  readonly payload: AppleNativeAttestationPayload;
  readonly signature: string;
}

export interface OperationDefinition {
  readonly operation_id: string;
  readonly enabled: boolean;
  readonly provider: ProviderId;
  readonly image: string;
  readonly command: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  readonly architecture: "arm64" | "amd64";
  readonly network: "none";
  readonly uid: number;
  readonly gid: number;
  readonly inputs: ReadonlyArray<OperationInputSlot>;
  readonly outputs: ReadonlyArray<OperationOutput>;
  readonly resources: OperationResources;
}

export interface ResolvedInputArtifact {
  readonly slot: OperationInputSlot;
  readonly metadata: ArtifactMetadata;
  /** Immutable bytes verified from one CAS file descriptor before provider admission. */
  readonly bytes: Buffer;
}

export interface ProviderExecution {
  readonly job_id: string;
  readonly provider_attestation_id: string;
  readonly attestation_challenge: string;
  readonly operation: OperationDefinition;
  readonly inputs: ReadonlyArray<ResolvedInputArtifact>;
}

export interface ProviderOutput {
  readonly definition: OperationOutput;
  readonly bytes: Uint8Array;
}

export interface ProviderExecutionResult {
  readonly exit_code: number;
  readonly timed_out: boolean;
  readonly duration_ms: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly outputs: ReadonlyArray<ProviderOutput>;
  readonly attestation: ProviderExecutionAttestation;
}

export interface NativeDriverRequest {
  readonly protocol_version: "1";
  readonly container_id: string;
  readonly provider_attestation_id: string;
  readonly attestation_challenge: string;
  readonly image_reference: string;
  readonly image_store_root: string;
  readonly kernel_path: string;
  readonly initfs_path: string;
  readonly work_root: string;
  readonly output_directory: string;
  readonly command: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<string>;
  readonly architecture: "arm64" | "amd64";
  readonly uid: number;
  readonly gid: number;
  readonly cpus: number;
  readonly memory_bytes: number;
  readonly rootfs_bytes: number;
  readonly writable_layer_bytes: number;
  readonly output_disk_bytes: number;
  readonly timeout_seconds: number;
  readonly max_log_bytes: number;
  readonly max_processes: number;
  readonly max_open_files: number;
  readonly inputs: ReadonlyArray<{
    readonly name: string;
    readonly host_path: string;
    readonly sha256: string;
    readonly size_bytes: number;
  }>;
  readonly outputs: ReadonlyArray<{
    readonly name: string;
    readonly required: boolean;
    readonly max_bytes: number;
  }>;
}
