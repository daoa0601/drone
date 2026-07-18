export const DRONE_PROTOCOL_VERSION = "1" as const;

export type ProviderId = "apple_native";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface OperationInputSlot {
  readonly name: string;
  readonly required: boolean;
  readonly max_bytes: number;
  readonly media_types: ReadonlyArray<string>;
}

export interface OperationOutput {
  readonly name: string;
  readonly required: boolean;
  readonly max_bytes: number;
  readonly media_type: string;
}

export interface OperationResources {
  readonly cpus: number;
  readonly memory_mb: number;
  readonly rootfs_mb: number;
  readonly writable_mb: number;
  readonly output_disk_mb: number;
  readonly timeout_seconds: number;
  readonly max_log_bytes: number;
  readonly max_processes: number;
  readonly max_open_files: number;
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

export interface PublicOperation {
  readonly operation_id: string;
  readonly enabled: boolean;
  readonly provider: ProviderId;
  readonly architecture: "arm64" | "amd64";
  readonly network: "none";
  readonly inputs: ReadonlyArray<OperationInputSlot>;
  readonly outputs: ReadonlyArray<OperationOutput>;
  readonly resources: OperationResources;
}

export interface JobSubmission {
  readonly schema_version: "1";
  readonly operation_id: string;
  readonly inputs: Readonly<Record<string, string>>;
}

export interface ArtifactMetadata {
  readonly schema_version: "1";
  readonly artifact_id: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly created_at: string;
}

export interface JobOutputArtifact {
  readonly name: string;
  readonly artifact_id: string;
  readonly size_bytes: number;
  readonly media_type: string;
}

export interface JobRecord {
  readonly schema_version: "1";
  readonly job_id: string;
  readonly operation_id: string;
  readonly provider_id: ProviderId;
  readonly status: JobStatus;
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: ReadonlyArray<JobOutputArtifact>;
  readonly submitted_at: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly exit_code?: number;
  readonly timed_out?: boolean;
  readonly stdout_artifact_id?: string;
  readonly stderr_artifact_id?: string;
  readonly error_code?: string;
}

export interface ProviderStatus {
  readonly provider_id: ProviderId;
  readonly product: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly mutations_available: boolean;
  readonly reason: string;
  readonly isolation: "lightweight_vm";
  readonly guest_os: ReadonlyArray<"linux">;
  readonly network_modes: ReadonlyArray<"none">;
}

export interface ResolvedInputArtifact {
  readonly slot: OperationInputSlot;
  readonly metadata: ArtifactMetadata;
  /** Immutable bytes verified from one CAS file descriptor before provider admission. */
  readonly bytes: Buffer;
}

export interface ProviderExecution {
  readonly job_id: string;
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
}

export interface NativeDriverRequest {
  readonly protocol_version: "1";
  readonly container_id: string;
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
