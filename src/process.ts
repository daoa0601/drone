import { BoundedProcessError, runBoundedProcess } from "@agentic-orch/node-guardrails/process";
import { Effect } from "effect";

import { DroneError, providerFailed } from "./errors.js";

export interface ProcessRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
}

function providerProcessError(cause: BoundedProcessError): DroneError {
  switch (cause.kind) {
    case "aborted":
      return providerFailed("Native driver was interrupted.", cause);
    case "launch_failed":
      return providerFailed("Unable to launch the native driver.", cause);
    case "stderr_limit":
      return providerFailed("Native driver diagnostics exceeded their byte limit.", cause);
    case "stdout_limit":
      return providerFailed("Native driver response exceeded its byte limit.", cause);
    case "timed_out":
      return providerFailed("Native driver exceeded its host watchdog.", cause);
  }
}

export function runProcess(request: ProcessRequest): Effect.Effect<ProcessResult, DroneError> {
  return Effect.tryPromise({
    try: async (signal) => {
      try {
        return await runBoundedProcess({ ...request, signal });
      } catch (cause) {
        if (cause instanceof BoundedProcessError) throw providerProcessError(cause);
        throw cause;
      }
    },
    catch: (cause) =>
      cause instanceof DroneError ? cause : providerFailed("Native driver process failed.", cause),
  });
}
