import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  ContentAddressedFileStore,
  ContentAddressedStoreError,
  type StoredContent,
  type VerifiedContent,
} from "@agentic-orch/node-guardrails/cas";

import { isDroneArtifactId, isDroneMediaType } from "@agentic-orch/drone-client";

import type { ArtifactMetadata } from "./domain.js";
import { DroneError, invalidInput } from "./errors.js";

const MAX_METADATA_BYTES = 4 * 1024;

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
}

export interface VerifiedArtifact {
  readonly metadata: ArtifactMetadata;
  readonly bytes: Buffer;
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function normalizedMediaType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!isDroneMediaType(normalized)) throw invalidInput("Artifact media type is invalid.");
  return normalized;
}

function artifactInvalid(message: string, cause?: unknown): DroneError {
  return new DroneError({
    code: "ARTIFACT_INVALID",
    message,
    status: 500,
    expose: false,
    cause,
  });
}

function validatePrivateDirectory(info: BigIntStats): void {
  const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw artifactInvalid("Artifact metadata root must be a real directory.");
  }
  if (uid !== undefined && info.uid !== uid) {
    throw artifactInvalid("Artifact metadata root has an unexpected owner.");
  }
  if ((info.mode & 0o077n) !== 0n) {
    throw artifactInvalid("Artifact metadata root permissions are not private.");
  }
}

async function readStable(handle: FileHandle, maximum: number): Promise<Buffer> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximum)) {
    throw artifactInvalid("Artifact metadata is not a bounded regular file.");
  }
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const extra = await handle.read(probe, 0, 1, offset);
  const after = await handle.stat({ bigint: true });
  if (
    offset !== bytes.byteLength ||
    extra.bytesRead !== 0 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw artifactInvalid("Artifact metadata changed while it was being read.");
  }
  return bytes;
}

export class ArtifactStore {
  readonly #metadataRoot: string;
  readonly #maxBytes: number;
  readonly #blobs: ContentAddressedFileStore;
  #metadataIdentity: DirectoryIdentity | undefined;
  #initialization: Promise<void> | undefined;

  constructor(root: string, maxBytes: number) {
    const resolved = path.resolve(root);
    this.#metadataRoot = path.join(resolved, "metadata");
    this.#maxBytes = maxBytes;
    this.#blobs = new ContentAddressedFileStore({
      root: path.join(resolved, "blobs"),
      maxBytes,
    });
  }

  async initialize(): Promise<void> {
    this.#initialization ??= this.#initialize().catch((cause: unknown) => {
      this.#initialization = undefined;
      throw cause;
    });
    await this.#initialization;
    await Promise.all([this.#blobs.initialize(), this.#assertMetadataRoot()]);
  }

  async stage(bytes: Uint8Array, mediaType: string): Promise<ArtifactMetadata> {
    if (bytes.byteLength === 0) {
      throw new DroneError({
        code: "ARTIFACT_INVALID",
        message: "Artifact must not be empty.",
        status: 400,
      });
    }
    if (bytes.byteLength > this.#maxBytes) {
      throw new DroneError({
        code: "ARTIFACT_LIMIT_EXCEEDED",
        message: `Artifact exceeds the ${this.#maxBytes}-byte limit.`,
        status: 413,
      });
    }
    const normalizedType = normalizedMediaType(mediaType);
    await this.initialize();
    const stored = await this.#blobs.stage(bytes).catch((cause: unknown) => {
      throw this.#stageError(cause, false);
    });
    return this.#record(stored, normalizedType);
  }

  async stageFile(
    file: string,
    mediaType: string,
    maximum = this.#maxBytes,
  ): Promise<ArtifactMetadata> {
    const normalizedType = normalizedMediaType(mediaType);
    await this.initialize();
    const stored = await this.#blobs.stageFile(file, maximum).catch((cause: unknown) => {
      throw this.#stageError(cause, true);
    });
    return this.#record(stored, normalizedType);
  }

  async inspect(artifactId: string): Promise<ArtifactMetadata> {
    return (await this.#verified(artifactId)).metadata;
  }

  async read(artifactId: string): Promise<VerifiedArtifact> {
    const verified = await this.#verified(artifactId);
    return { metadata: verified.metadata, bytes: verified.content.bytes };
  }

  async #initialize(): Promise<void> {
    await this.#blobs.initialize();
    await mkdir(this.#metadataRoot, { recursive: true, mode: 0o700 });
    const lexical = await lstat(this.#metadataRoot, { bigint: true });
    validatePrivateDirectory(lexical);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.#metadataRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat({ bigint: true });
      validatePrivateDirectory(info);
      this.#metadataIdentity = { dev: info.dev, ino: info.ino, uid: info.uid };
    } catch (cause) {
      if (cause instanceof DroneError) throw cause;
      throw artifactInvalid("Unable to initialize artifact metadata custody.", cause);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #assertMetadataRoot(): Promise<void> {
    const expected = this.#metadataIdentity;
    if (expected === undefined) {
      throw artifactInvalid("Artifact metadata custody is not initialized.");
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.#metadataRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat({ bigint: true });
      validatePrivateDirectory(info);
      if (info.dev !== expected.dev || info.ino !== expected.ino || info.uid !== expected.uid) {
        throw artifactInvalid("Artifact metadata root identity changed.");
      }
    } catch (cause) {
      if (cause instanceof DroneError) throw cause;
      throw artifactInvalid("Unable to revalidate artifact metadata custody.", cause);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #readMetadata(sha256: string): Promise<unknown> {
    let handle: FileHandle | undefined;
    try {
      await this.#assertMetadataRoot();
      handle = await open(this.#metadataPath(sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
      await this.#assertMetadataRoot();
      const info = await handle.stat({ bigint: true });
      const expected = this.#metadataIdentity!;
      if (
        !info.isFile() ||
        info.dev !== expected.dev ||
        info.uid !== expected.uid ||
        (info.mode & 0o022n) !== 0n
      ) {
        throw artifactInvalid("Artifact metadata ownership or permissions are unsafe.");
      }
      const bytes = await readStable(handle, MAX_METADATA_BYTES);
      await this.#assertMetadataRoot();
      try {
        return JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (cause) {
        throw artifactInvalid("Artifact metadata is invalid.", cause);
      }
    } catch (cause) {
      if (cause instanceof DroneError) throw cause;
      if (nodeCode(cause) === "ENOENT") {
        throw new DroneError({
          code: "NOT_FOUND",
          message: "Artifact was not found.",
          status: 404,
          cause,
        });
      }
      throw artifactInvalid("Artifact metadata is unavailable.", cause);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #verified(artifactId: string): Promise<{
    readonly metadata: ArtifactMetadata;
    readonly content: VerifiedContent;
  }> {
    const sha256 = this.#digest(artifactId);
    await this.initialize();
    const value = await this.#readMetadata(sha256);
    if (typeof value !== "object" || value === null) {
      throw artifactInvalid("Artifact metadata is invalid.");
    }
    const metadata = value as Partial<ArtifactMetadata>;
    const content = await this.#blobs.read(sha256).catch((cause: unknown) => {
      throw this.#blobError(cause);
    });
    if (
      metadata.schema_version !== "1" ||
      metadata.artifact_id !== artifactId ||
      metadata.sha256 !== sha256 ||
      metadata.size_bytes !== content.size ||
      typeof metadata.media_type !== "string" ||
      !isDroneMediaType(metadata.media_type) ||
      typeof metadata.created_at !== "string"
    ) {
      throw artifactInvalid("Artifact metadata is inconsistent.");
    }
    return { metadata: metadata as ArtifactMetadata, content };
  }

  #digest(artifactId: string): string {
    if (!isDroneArtifactId(artifactId)) throw invalidInput("Artifact ID is invalid.");
    return artifactId.slice("sha256_".length);
  }

  #metadataPath(sha256: string): string {
    return path.join(this.#metadataRoot, `${sha256}.json`);
  }

  async #record(stored: StoredContent, mediaType: string): Promise<ArtifactMetadata> {
    const artifactId = `sha256_${stored.digest}`;
    const candidate: ArtifactMetadata = {
      schema_version: "1",
      artifact_id: artifactId,
      sha256: stored.digest,
      size_bytes: stored.size,
      media_type: mediaType,
      created_at: new Date().toISOString(),
    };
    await this.#atomicCreate(
      this.#metadataPath(stored.digest),
      Buffer.from(`${JSON.stringify(candidate)}\n`),
    );
    const recorded = await this.inspect(artifactId);
    if (recorded.media_type !== mediaType) {
      throw new DroneError({
        code: "CONFLICT",
        message: "Artifact bytes are already registered with a different media type.",
        status: 409,
      });
    }
    return recorded;
  }

  async #atomicCreate(target: string, bytes: Uint8Array): Promise<void> {
    const temporary = `${target}.tmp-${randomUUID()}`;
    let handle: FileHandle | undefined;
    let rootIsCurrent = true;
    try {
      await this.#assertMetadataRoot();
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(bytes);
      const written = await readStable(handle, MAX_METADATA_BYTES);
      if (!written.equals(bytes)) {
        throw artifactInvalid("Artifact metadata changed before publication.");
      }
      await this.#assertMetadataRoot();
      try {
        await link(temporary, target);
      } catch (cause) {
        if (nodeCode(cause) !== "EEXIST") throw cause;
      }
      await this.#assertMetadataRoot();
    } catch (cause) {
      try {
        await this.#assertMetadataRoot();
      } catch {
        rootIsCurrent = false;
      }
      if (cause instanceof DroneError) throw cause;
      throw artifactInvalid("Unable to record artifact metadata.", cause);
    } finally {
      await handle?.close().catch(() => undefined);
      if (rootIsCurrent) await unlink(temporary).catch(() => undefined);
    }
  }

  #stageError(cause: unknown, fromFile: boolean): DroneError {
    if (cause instanceof ContentAddressedStoreError) {
      if (cause.kind === "content_too_large") {
        return new DroneError({
          code: "ARTIFACT_LIMIT_EXCEEDED",
          message: fromFile
            ? "Artifact output exceeded its declared limit."
            : `Artifact exceeds the ${this.#maxBytes}-byte limit.`,
          status: 413,
          cause,
        });
      }
      if (cause.kind === "empty_content" || (fromFile && cause.kind === "invalid_file")) {
        return new DroneError({
          code: "ARTIFACT_INVALID",
          message:
            cause.kind === "empty_content"
              ? "Artifact must not be empty."
              : "Artifact output must be a regular file.",
          status: 400,
          cause,
        });
      }
    }
    return new DroneError({
      code: "ARTIFACT_INVALID",
      message: fromFile ? "Artifact output is unavailable." : "Unable to store artifact.",
      status: 500,
      expose: false,
      cause,
    });
  }

  #blobError(cause: unknown): DroneError {
    if (cause instanceof ContentAddressedStoreError && cause.kind === "not_found") {
      return new DroneError({
        code: "NOT_FOUND",
        message: "Artifact was not found.",
        status: 404,
        cause,
      });
    }
    return artifactInvalid("Artifact blob failed custody verification.", cause);
  }
}
