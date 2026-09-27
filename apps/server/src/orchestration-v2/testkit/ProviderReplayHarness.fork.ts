// Fork-only (zmux-estate): lets a replay wrap the turn-start service its effect
// worker runs, as `runtimeLayer.ts` wraps it with the checkout gate. Reached
// from the replay harness through `zmux-estate/replay-turn-start-wrapper`.
import type * as Layer from "effect/Layer";

import type * as Orchestrator from "../Orchestrator.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";
import type * as ProviderSessionManager from "../ProviderSessionManager.ts";
import type { ProviderTurnStartServiceV2 } from "../ProviderTurnStartService.ts";

/** The replay's own instances, shared with its orchestrator and effect worker. */
export type ReplayTurnStartDependenciesFork =
  | ProviderTurnStartServiceV2
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | Orchestrator.OrchestratorV2;

/** Builds the turn-start service the effect worker runs over the replay's own. */
export type ReplayTurnStartWrapperFork = <E, R>(
  dependencies: Layer.Layer<ReplayTurnStartDependenciesFork, E, R>,
) => Layer.Layer<ProviderTurnStartServiceV2, E, R>;
