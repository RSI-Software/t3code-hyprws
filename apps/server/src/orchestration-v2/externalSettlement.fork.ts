// External MCP mode ceilings hold at settlement commit, under the thread lock.
import type { OrchestrationV2AppThread, OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const refuseStaleExternalSettlementFork = <E>(
  command: OrchestrationV2ServerCommand,
  thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">,
  refuse: (cause: string) => E,
): Effect.Effect<void, E> => {
  if (command.type !== "thread.settle" && command.type !== "thread.unsettle") return Effect.void;
  const modes = command.expectedModes;
  return modes === undefined ||
    (modes.runtimeMode === thread.runtimeMode && modes.interactionMode === thread.interactionMode)
    ? Effect.void
    : Effect.fail(refuse("The thread's modes changed after this settlement was vetted."));
};
