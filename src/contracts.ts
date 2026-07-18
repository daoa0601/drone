import { Schema, SchemaParser } from "effect";

import type {
  JobSubmission,
  OperationDefinition,
  OperationInputSlot,
  OperationOutput,
  OperationResources,
} from "./domain.js";
import { invalidInput } from "./errors.js";

const InputSlotSchema = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  max_bytes: Schema.Number,
  media_types: Schema.Array(Schema.String),
});

const OutputSchema = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  max_bytes: Schema.Number,
  media_type: Schema.String,
});

const ResourcesSchema = Schema.Struct({
  cpus: Schema.Number,
  memory_mb: Schema.Number,
  rootfs_mb: Schema.Number,
  writable_mb: Schema.Number,
  output_disk_mb: Schema.Number,
  timeout_seconds: Schema.Number,
  max_log_bytes: Schema.Number,
  max_processes: Schema.Number,
  max_open_files: Schema.Number,
});

const OperationSchema = Schema.Struct({
  operation_id: Schema.String,
  enabled: Schema.Boolean,
  provider: Schema.Literal("apple_native"),
  image: Schema.String,
  command: Schema.Array(Schema.String),
  environment: Schema.Record(Schema.String, Schema.String),
  architecture: Schema.Literals(["arm64", "amd64"]),
  network: Schema.Literal("none"),
  uid: Schema.Number,
  gid: Schema.Number,
  inputs: Schema.Array(InputSlotSchema),
  outputs: Schema.Array(OutputSchema),
  resources: ResourcesSchema,
});

const RegistrySchema = Schema.Struct({
  schema_version: Schema.Literal("1"),
  operations: Schema.Array(OperationSchema),
});

const JobSubmissionSchema = Schema.Struct({
  schema_version: Schema.Literal("1"),
  operation_id: Schema.String,
  inputs: Schema.Record(Schema.String, Schema.String),
});

const decodeRegistryShape = SchemaParser.decodeUnknownSync(RegistrySchema, {
  errors: "all",
  onExcessProperty: "error",
});
const decodeJobShape = SchemaParser.decodeUnknownSync(JobSubmissionSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const SAFE_ID = /^[a-z][a-z0-9_.-]{0,127}$/u;
const SAFE_SLOT = /^[a-z][a-z0-9_-]{0,63}$/u;
const ARTIFACT_ID = /^sha256_[a-f0-9]{64}$/u;
const IMAGE_DIGEST =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/iu;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const MIB = 1024 * 1024;

function safeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_ID.test(normalized)) throw invalidInput(`${label} is invalid.`);
  return normalized;
}

function safeSlot(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_SLOT.test(normalized)) throw invalidInput(`${label} is invalid.`);
  return normalized;
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function mediaType(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!MEDIA_TYPE.test(normalized)) throw invalidInput(`${label} is invalid.`);
  return normalized;
}

function normalizeInputs(
  values: ReadonlyArray<typeof InputSlotSchema.Type>,
  operationIndex: number,
): ReadonlyArray<OperationInputSlot> {
  if (values.length > 16) throw invalidInput(`operations[${operationIndex}].inputs exceeds 16.`);
  const names = new Set<string>();
  return values.map((input, index) => {
    const prefix = `operations[${operationIndex}].inputs[${index}]`;
    const name = safeSlot(input.name, `${prefix}.name`);
    if (names.has(name)) throw invalidInput(`${prefix}.name is duplicated.`);
    names.add(name);
    if (input.media_types.length === 0 || input.media_types.length > 16) {
      throw invalidInput(`${prefix}.media_types must contain 1-16 values.`);
    }
    const mediaTypes = input.media_types.map((value, mediaIndex) =>
      mediaType(value, `${prefix}.media_types[${mediaIndex}]`),
    );
    if (new Set(mediaTypes).size !== mediaTypes.length) {
      throw invalidInput(`${prefix}.media_types contains duplicates.`);
    }
    return {
      name,
      required: input.required,
      max_bytes: integer(input.max_bytes, 1, 1024 * MIB, `${prefix}.max_bytes`),
      media_types: mediaTypes,
    };
  });
}

function normalizeOutputs(
  values: ReadonlyArray<typeof OutputSchema.Type>,
  operationIndex: number,
): ReadonlyArray<OperationOutput> {
  if (values.length > 16) throw invalidInput(`operations[${operationIndex}].outputs exceeds 16.`);
  const names = new Set<string>();
  return values.map((output, index) => {
    const prefix = `operations[${operationIndex}].outputs[${index}]`;
    const name = safeSlot(output.name, `${prefix}.name`);
    if (names.has(name)) throw invalidInput(`${prefix}.name is duplicated.`);
    names.add(name);
    return {
      name,
      required: output.required,
      max_bytes: integer(output.max_bytes, 1, 256 * MIB, `${prefix}.max_bytes`),
      media_type: mediaType(output.media_type, `${prefix}.media_type`),
    };
  });
}

function normalizeResources(
  value: typeof ResourcesSchema.Type,
  operationIndex: number,
): OperationResources {
  const prefix = `operations[${operationIndex}].resources`;
  return {
    cpus: integer(value.cpus, 1, 16, `${prefix}.cpus`),
    memory_mb: integer(value.memory_mb, 128, 65_536, `${prefix}.memory_mb`),
    rootfs_mb: integer(value.rootfs_mb, 128, 65_536, `${prefix}.rootfs_mb`),
    writable_mb: integer(value.writable_mb, 16, 16_384, `${prefix}.writable_mb`),
    output_disk_mb: integer(value.output_disk_mb, 16, 4096, `${prefix}.output_disk_mb`),
    timeout_seconds: integer(value.timeout_seconds, 1, 3600, `${prefix}.timeout_seconds`),
    max_log_bytes: integer(value.max_log_bytes, 1024, 1024 * 1024, `${prefix}.max_log_bytes`),
    max_processes: integer(value.max_processes, 1, 1024, `${prefix}.max_processes`),
    max_open_files: integer(value.max_open_files, 16, 4096, `${prefix}.max_open_files`),
  };
}

function command(values: ReadonlyArray<string>, operationIndex: number): ReadonlyArray<string> {
  if (values.length === 0 || values.length > 64) {
    throw invalidInput(`operations[${operationIndex}].command must contain 1-64 arguments.`);
  }
  return values.map((value, index) => {
    if (value.length === 0 || value.length > 2048 || value.includes(String.fromCharCode(0))) {
      throw invalidInput(`operations[${operationIndex}].command[${index}] is invalid.`);
    }
    return value;
  });
}

function environment(
  value: Readonly<Record<string, string>>,
  operationIndex: number,
): Readonly<Record<string, string>> {
  const entries = Object.entries(value);
  if (entries.length > 32) {
    throw invalidInput(`operations[${operationIndex}].environment exceeds 32 entries.`);
  }
  return Object.fromEntries(
    entries
      .map(([key, raw]) => {
        if (!ENV_NAME.test(key)) {
          throw invalidInput(`operations[${operationIndex}].environment has an invalid key.`);
        }
        if (raw.length > 2048 || raw.includes(String.fromCharCode(0))) {
          throw invalidInput(`operations[${operationIndex}].environment.${key} is invalid.`);
        }
        return [key, raw] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function decodeOperationRegistry(value: unknown): ReadonlyArray<OperationDefinition> {
  let registry: typeof RegistrySchema.Type;
  try {
    registry = decodeRegistryShape(value);
  } catch (cause) {
    throw invalidInput("Operation registry does not match the strict v1 schema.", cause);
  }
  if (registry.operations.length > 128)
    throw invalidInput("Operation registry exceeds 128 entries.");
  const operationIds = new Set<string>();
  return registry.operations.map((operation, index) => {
    const operationId = safeId(operation.operation_id, `operations[${index}].operation_id`);
    if (operationIds.has(operationId))
      throw invalidInput(`Duplicate operation_id: ${operationId}.`);
    operationIds.add(operationId);
    if (!IMAGE_DIGEST.test(operation.image)) {
      throw invalidInput(`operations[${index}].image must be an exact sha256 OCI reference.`);
    }
    const inputs = normalizeInputs(operation.inputs, index);
    const outputs = normalizeOutputs(operation.outputs, index);
    const resources = normalizeResources(operation.resources, index);
    const declaredOutputBytes = outputs.reduce((total, output) => total + output.max_bytes, 0);
    if (declaredOutputBytes > (resources.output_disk_mb - 1) * MIB) {
      throw invalidInput(`operations[${index}] outputs exceed the bounded output disk.`);
    }
    return {
      operation_id: operationId,
      enabled: operation.enabled,
      provider: "apple_native",
      image: operation.image,
      command: command(operation.command, index),
      environment: environment(operation.environment, index),
      architecture: operation.architecture,
      network: "none",
      uid: integer(operation.uid, 1, 2_147_483_647, `operations[${index}].uid`),
      gid: integer(operation.gid, 1, 2_147_483_647, `operations[${index}].gid`),
      inputs,
      outputs,
      resources,
    };
  });
}

export function decodeJobSubmission(value: unknown): JobSubmission {
  let input: typeof JobSubmissionSchema.Type;
  try {
    input = decodeJobShape(value);
  } catch (cause) {
    throw invalidInput("Job submission does not match the strict v1 schema.", cause);
  }
  const entries = Object.entries(input.inputs);
  if (entries.length > 16) throw invalidInput("inputs exceeds 16 entries.");
  const inputs = Object.fromEntries(
    entries.map(([slot, artifactId]) => {
      const normalizedSlot = safeSlot(slot, "inputs key");
      if (!ARTIFACT_ID.test(artifactId)) {
        throw invalidInput(`inputs.${normalizedSlot} is not a content-addressed artifact ID.`);
      }
      return [normalizedSlot, artifactId] as const;
    }),
  );
  return {
    schema_version: "1",
    operation_id: safeId(input.operation_id, "operation_id"),
    inputs,
  };
}

export function isArtifactId(value: string): boolean {
  return ARTIFACT_ID.test(value);
}
