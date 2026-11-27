// Fork-only (colleague-collab): the server, not the client, decides that a shared-thread turn
// stayed quiet, so every client shows the same row and none parses the agent's text.
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";

/** The agent's whole reply to a shared-thread message that is between people. */
export const QUIET_MARKER = "(listening)";

/**
 * The `turn-item.updated` payload override for a finished agent reply that is the quiet marker or
 * empty, in a turn a shared-thread message started; otherwise nothing.
 * Untraced: it runs on every turn-item event, streaming deltas included, inside `normalize`.
 */
export const quietTurnPayloadFork = Effect.fnUntraced(function* (
  projections: Pick<ProjectionStoreV2Shape, "getRun" | "getTurnItem">,
  item: OrchestrationV2TurnItem,
) {
  if (item.type !== "assistant_message" || item.streaming || item.runId === null) return {};
  const text = item.text.trim();
  if (text !== "" && text !== QUIET_MARKER) return {};
  const run = yield* projections.getRun(item.threadId, item.runId);
  if (run === undefined) return {};
  const asked = yield* projections.getTurnItem({
    threadId: item.threadId,
    itemId: derive.userTurnItem({ messageId: run.userMessageId }),
  });
  if (asked?.type !== "user_message" || asked.context?.collaboratorFork === undefined) return {};
  return { payload: { ...item, quietFork: true as const } };
});
