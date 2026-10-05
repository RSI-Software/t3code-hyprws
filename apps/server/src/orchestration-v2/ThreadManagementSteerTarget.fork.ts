// Fork-owned steer pin for `ThreadManagementService.sendToThread`
// (RSI-Software/t3code-hyprws device-auth domain). A caller that vetted one
// run sets `steerTarget`, so a send never joins a run that became steerable
// after the caller looked: `auto` queues instead, and `steer` or `restart`
// fails. Dispatch then refuses the target once another run is active.
import type { OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ThreadManagementNoSteerableRunError,
  type ThreadManagementSendInput,
} from "./ThreadManagementService.ts";

type DispatchMode = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>["dispatchMode"];

/** Narrows the dispatch `sendToThread` chose to the run its caller vetted. */
export const pinSteerTargetFork = (
  input: ThreadManagementSendInput,
  dispatchMode: DispatchMode,
): Effect.Effect<DispatchMode, ThreadManagementNoSteerableRunError> => {
  if (
    input.steerTarget === undefined ||
    (dispatchMode.type !== "steer_active" && dispatchMode.type !== "restart_active") ||
    dispatchMode.targetRunId === input.steerTarget
  ) {
    return Effect.succeed(dispatchMode);
  }
  return input.mode === "steer" || input.mode === "restart"
    ? Effect.fail(
        new ThreadManagementNoSteerableRunError({ threadId: input.threadId, mode: input.mode }),
      )
    : Effect.succeed({ type: "queue_after_active" });
};
