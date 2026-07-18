import type { Effect } from "effect";

import type {
  ProviderExecution,
  ProviderExecutionResult,
  ProviderId,
  ProviderStatus,
} from "./domain.js";
import type { DroneError } from "./errors.js";

export interface SandboxProvider {
  readonly providerId: ProviderId;
  readonly status: () => Promise<ProviderStatus>;
  readonly run: (
    execution: ProviderExecution,
  ) => Effect.Effect<ProviderExecutionResult, DroneError>;
}
