import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { decodeOperationRegistry } from "./contracts.js";
import type { OperationDefinition, PublicOperation } from "./domain.js";
import { DroneError } from "./errors.js";

const EMPTY_REGISTRY = `${JSON.stringify({ schema_version: "1", operations: [] }, null, 2)}\n`;

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function initializeFile(file: string): Promise<void> {
  const temporary = `${file}.tmp-${randomUUID()}`;
  await writeFile(temporary, EMPTY_REGISTRY, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, file);
  } catch (cause) {
    if (nodeCode(cause) !== "EEXIST") throw cause;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function publicOperation(operation: OperationDefinition): PublicOperation {
  return {
    operation_id: operation.operation_id,
    enabled: operation.enabled,
    provider: operation.provider,
    architecture: operation.architecture,
    network: operation.network,
    inputs: operation.inputs,
    outputs: operation.outputs,
    resources: operation.resources,
  };
}

export class OperationRegistry {
  readonly #file: string;
  #operations = new Map<string, OperationDefinition>();

  constructor(file: string) {
    this.#file = path.resolve(file);
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    await initializeFile(this.#file);
    await this.reload();
  }

  async reload(): Promise<void> {
    const info = await lstat(this.#file).catch((cause: unknown) => {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "Operation registry is unavailable.",
        status: 503,
        expose: false,
        cause,
      });
    });
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "Operation registry must be a regular file.",
        status: 503,
        expose: false,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#file, "utf8")) as unknown;
    } catch (cause) {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "Operation registry is not valid JSON.",
        status: 503,
        expose: false,
        cause,
      });
    }
    let decoded: ReadonlyArray<OperationDefinition>;
    try {
      decoded = decodeOperationRegistry(value);
    } catch (cause) {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "Operation registry failed validation.",
        status: 503,
        expose: false,
        cause,
      });
    }
    this.#operations = new Map(decoded.map((operation) => [operation.operation_id, operation]));
  }

  list(): ReadonlyArray<PublicOperation> {
    return [...this.#operations.values()]
      .sort((left, right) => left.operation_id.localeCompare(right.operation_id))
      .map(publicOperation);
  }

  get(operationId: string): OperationDefinition {
    const operation = this.#operations.get(operationId);
    if (operation === undefined) {
      throw new DroneError({
        code: "NOT_FOUND",
        message: "Operation was not found.",
        status: 404,
      });
    }
    if (!operation.enabled) {
      throw new DroneError({
        code: "OPERATION_DISABLED",
        message: "Operation is disabled.",
        status: 409,
      });
    }
    return operation;
  }
}
