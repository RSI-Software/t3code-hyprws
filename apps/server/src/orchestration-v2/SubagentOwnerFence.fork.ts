import {
  isOrchestrationV2WorkActive,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export interface SubagentOwnerGuardFork {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly transfer?: {
    readonly subagentId: NodeId;
    readonly parentProviderThreadId: ProviderThreadId;
  };
}

// Run inside EventSink's write transaction: subscriber-local routing can lag
// a handoff that another subscriber has already committed.
export const guardSubagentOwnershipFork = Effect.fn("EventSink.guardSubagentOwnershipFork")(
  function* (
    sql: SqlClient.SqlClient,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    guard: SubagentOwnerGuardFork,
  ) {
    const accepted: Array<OrchestrationV2DomainEvent> = [];
    for (const event of events) {
      const subagentId =
        event.type === "subagent.updated"
          ? event.payload.id
          : event.type === "node.updated" && event.payload.kind === "subagent"
            ? event.payload.id
            : event.type === "turn-item.updated" && event.payload.type === "subagent"
              ? event.payload.subagentId
              : null;
      // Nested artifacts may name a null-owned row; also check the child
      // thread containing them rather than treating that row as unlinked.
      const childThreadId =
        event.threadId !== guard.threadId &&
        (event.type === "subagent.updated" ||
          event.type === "thread.model-selection-updated" ||
          event.type === "node.updated" ||
          event.type === "turn-item.updated" ||
          event.type === "message.updated" ||
          event.type === "plan.updated" ||
          event.type === "runtime-request.updated" ||
          event.type === "provider-turn.updated" ||
          event.type === "provider-thread.updated")
          ? event.threadId
          : null;
      // Ordinary root events keep their existing persistence gates.
      if (subagentId === null && childThreadId === null) {
        accepted.push(event);
        continue;
      }
      const owners = yield* sql<{ readonly run_id: string }>`
        SELECT run_id FROM orchestration_v2_projection_subagents
        WHERE (subagent_id = ${subagentId} OR child_thread_id = ${childThreadId})
          AND run_id IS NOT NULL
      `;
      const expectedOwner = event.runId ?? guard.runId;
      if (owners.every((owner) => owner.run_id === expectedOwner)) {
        accepted.push(event);
        continue;
      }
      if (
        event.type !== "subagent.updated" ||
        guard.transfer === undefined ||
        event.payload.id !== guard.transfer.subagentId ||
        event.payload.runId !== guard.runId ||
        event.payload.threadId !== guard.threadId ||
        event.payload.childThreadId === null ||
        !isOrchestrationV2WorkActive(event.payload.status)
      )
        continue;
      // Only an explicit resume from the current parent run may change owner.
      // An earlier resume can itself be backlogged, so evidence alone is not
      // enough: verify the persisted parent ordinal in this same transaction.
      const claimant = yield* sql<{ readonly run_id: string }>`
        SELECT r.run_id FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_provider_threads p
          ON p.provider_thread_id = r.provider_thread_id AND p.thread_id = r.thread_id
        WHERE r.run_id = ${guard.runId} AND r.thread_id = ${guard.threadId}
          AND p.provider_thread_id = ${guard.transfer.parentProviderThreadId}
          AND p.last_run_ordinal = r.ordinal
        LIMIT 1
      `;
      if (claimant.length > 0) accepted.push(event);
    }
    return accepted;
  },
);
