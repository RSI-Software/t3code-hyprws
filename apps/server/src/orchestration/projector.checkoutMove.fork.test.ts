import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("checkout move projector", () => {
  it("projects canonical and worktree destinations in both directions", async () => {
    const now = "2026-09-05T00:00:00.000Z";
    let model = createEmptyReadModel(now);
    model = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "project.created",
          aggregateKind: "project",
          aggregateId: "project-1",
          occurredAt: now,
          commandId: "project",
          payload: {
            projectId: "project-1",
            title: "Project",
            workspaceRoot: "/repo",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );
    model = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 2,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "thread",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "Thread",
            modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5-codex" },
            interactionMode: "default",
            runtimeMode: "full-access",
            branch: "feature",
            worktreePath: "/repo/wt",
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );
    const identity = (checkoutRoot: string, branch: string | null) => ({
      repositoryRoot: "/repo",
      checkoutRoot,
      revision: "abc",
      branch,
    });
    const move = (destination: ReturnType<typeof identity>, updatedAt: string) => ({
      requestId: `request-${updatedAt}`,
      source: identity("/repo/wt", "feature"),
      requestedPath: destination.checkoutRoot,
      destination,
      expectedCheckoutRoot: "/repo/wt",
      status: "committed",
      completedSteps: ["provider", "metadata"],
      effectiveProvider: destination,
      providerAvailable: true,
      requestedAt: now,
      updatedAt,
    });
    model = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 3,
          type: "thread.checkout-move-updated",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "canonical",
          payload: {
            threadId: "thread-1",
            move: move(identity("/repo", "main"), "2026-09-05T00:00:01.000Z"),
          },
        }),
      ),
    );
    expect(model.threads[0]?.worktreePath).toBeNull();
    model = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 4,
          type: "thread.checkout-move-updated",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "worktree",
          payload: {
            threadId: "thread-1",
            move: move(identity("/repo/wt", "feature"), "2026-09-05T00:00:02.000Z"),
          },
        }),
      ),
    );
    expect(model.threads[0]?.worktreePath).toBe("/repo/wt");
  });
});
