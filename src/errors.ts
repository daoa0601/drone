export type DroneErrorCode =
  | "ARTIFACT_INVALID"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "AUTH_REQUIRED"
  | "BODY_TOO_LARGE"
  | "CONFLICT"
  | "INTERNAL_ERROR"
  | "INVALID_INPUT"
  | "JOB_NOT_ACTIVE"
  | "NOT_FOUND"
  | "OPERATION_DISABLED"
  | "PROVIDER_FAILED"
  | "SERVICE_UNAVAILABLE";

export class DroneError extends Error {
  readonly code: DroneErrorCode;
  readonly status: number;
  readonly expose: boolean;

  constructor(options: {
    readonly code: DroneErrorCode;
    readonly message: string;
    readonly status: number;
    readonly expose?: boolean;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "DroneError";
    this.code = options.code;
    this.status = options.status;
    this.expose = options.expose ?? options.status < 500;
  }
}

export function invalidInput(message: string, cause?: unknown): DroneError {
  return new DroneError({ code: "INVALID_INPUT", message, status: 400, cause });
}

export function providerFailed(message: string, cause?: unknown): DroneError {
  return new DroneError({
    code: "PROVIDER_FAILED",
    message,
    status: 502,
    expose: false,
    cause,
  });
}

export function serviceUnavailable(message: string, cause?: unknown): DroneError {
  return new DroneError({
    code: "SERVICE_UNAVAILABLE",
    message,
    status: 503,
    expose: false,
    cause,
  });
}

export function redactedError(error: unknown): {
  readonly status: number;
  readonly body: { readonly error: { readonly code: DroneErrorCode; readonly message: string } };
} {
  const known = error instanceof DroneError ? error : undefined;
  return {
    status: known?.status ?? 500,
    body: {
      error: {
        code: known?.code ?? "INTERNAL_ERROR",
        message: known?.expose === true ? known.message : "The request could not be completed.",
      },
    },
  };
}
