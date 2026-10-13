import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
  RunId,
  ThreadId,
  ProviderSessionId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** A deliberate teardown ends owned turns without reporting a provider failure. */
export const detachedTurnEventsFork = (
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "providerTurns" | "runs">,
  sessionId: ProviderSessionId,
): ReadonlyArray<ProviderAdapterV2Event> =>
  projection.providerTurns.flatMap((turn) => {
    const owner = projection.providerThreads.find(
      (thread) => thread.id === turn.providerThreadId && thread.providerSessionId === sessionId,
    );
    const run = projection.runs.find(
      (candidate) =>
        candidate.activeAttemptId === turn.runAttemptId && candidate.status === "running",
    );
    if (
      turn.status !== "running" ||
      turn.runAttemptId === null ||
      owner === undefined ||
      run === undefined
    )
      return [];
    return [
      {
        type: "turn.terminal",
        driver: owner.driver,
        providerThreadId: owner.id,
        providerTurnId: turn.id,
        runOrdinal: run.ordinal,
        status: "interrupted",
        failure: null,
        threadDisposition: "reusable",
      },
    ];
  });

/** A closed native session cannot finish the tool calls it left open. */
type ReleasedToolEvent =
  | Omit<Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>, "id">
  | Omit<Extract<OrchestrationV2DomainEvent, { type: "node.updated" }>, "id">;
export const releasedToolEventsFork = (
  threadId: ThreadId,
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "turnItems" | "nodes">,
  sessionId: ProviderSessionId,
  releasedAt: DateTime.Utc,
  status: "failed" | "interrupted",
): ReadonlyArray<ReleasedToolEvent> => {
  const ownedThreads = new Set(
    projection.providerThreads.filter((p) => p.providerSessionId === sessionId).map((p) => p.id),
  );
  return projection.turnItems.flatMap((item): Array<ReleasedToolEvent> => {
    if (
      item.type !== "dynamic_tool" ||
      item.providerThreadId === null ||
      !ownedThreads.has(item.providerThreadId) ||
      !["pending", "running", "waiting"].includes(item.status) ||
      DateTime.isGreaterThan(item.updatedAt, releasedAt)
    )
      return [];
    const base = { threadId, occurredAt: releasedAt };
    const node = projection.nodes.find((n) => n.id === item.nodeId);
    return [
      {
        ...base,
        type: "turn-item.updated",
        ...(item.runId === null ? {} : { runId: item.runId }),
        ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
        payload: { ...item, status, completedAt: releasedAt, updatedAt: releasedAt },
      },
      ...(node === undefined || !["pending", "running", "waiting"].includes(node.status)
        ? []
        : [
            {
              ...base,
              type: "node.updated" as const,
              nodeId: node.id,
              ...(node.runId === null ? {} : { runId: node.runId }),
              payload: { ...node, status, completedAt: releasedAt },
            },
          ]),
    ];
  });
};

/** Runs that already ended own the stranded requests a Stop or interrupt retires. */
export const finishedRunIdsFork = (
  runs: ReadonlyArray<Pick<OrchestrationV2ThreadProjection["runs"][number], "id" | "status">>,
): ReadonlySet<RunId> =>
  new Set(
    runs
      .filter(
        (run) => !["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
      )
      .map((run) => run.id),
  );

/** Stop also retires questions stranded by a previously failed run. */
export const cancelStoppedRuntimeRequestsFork = <E>(input: {
  threadId: ThreadId;
  runIds: ReadonlySet<RunId>;
  includeRunless?: boolean;
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "nodes" | "turnItems">;
  now: DateTime.Utc;
  emit: <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<unknown, E>;
}) =>
  Effect.gen(function* () {
    for (const request of input.projection.runtimeRequests) {
      const node = input.projection.nodes.find((candidate) => candidate.id === request.nodeId);
      if (
        request.status !== "pending" ||
        (node?.runId == null ? !input.includeRunless : !input.runIds.has(node.runId))
      )
        continue;
      const base = { threadId: input.threadId, nodeId: request.nodeId, occurredAt: input.now };
      yield* input.emit<Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>>({
        ...base,
        type: "runtime-request.updated",
        payload: {
          ...request,
          status: "cancelled",
          resolvedAt: input.now,
          responseCapability: { type: "not_resumable", reason: "The owning work was stopped." },
        },
      });
      if (node !== undefined && ["pending", "running", "waiting"].includes(node.status)) {
        yield* input.emit<Extract<OrchestrationV2DomainEvent, { type: "node.updated" }>>({
          ...base,
          type: "node.updated",
          payload: { ...node, status: "cancelled", completedAt: input.now },
        });
      }
      for (const item of input.projection.turnItems) {
        if (
          (item.type !== "user_input_request" && item.type !== "approval_request") ||
          item.requestId !== request.id
        )
          continue;
        yield* input.emit<Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>>({
          ...base,
          type: "turn-item.updated",
          payload: { ...item, status: "cancelled", completedAt: input.now, updatedAt: input.now },
        });
      }
    }
  });
