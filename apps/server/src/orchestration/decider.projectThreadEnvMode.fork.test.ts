import { CommandId, EventId, ProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-env-mode");
const seedProjectCreated = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`evt-project-env-mode-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make(`cmd-project-env-mode-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-project-env-mode-${sequence}`),
  metadata: {},
  payload: {
    projectId,
    title: "Env mode",
    workspaceRoot: "/tmp/env-mode",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});
it.layer(NodeServices.layer)("decider project defaults", (it) => {
  it.effect("stores the fork mode a client sent as a wire pair, and re-splits it", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated(1));
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-env-mode-worktrunk"),
          projectId,
          defaultThreadEnvMode: "worktree",
          defaultThreadEnvModeFork: "worktrunk",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      // The event log holds the exact mode; only the wire needs the pair.
      expect(
        (
          event.payload as {
            defaultThreadEnvMode?: unknown;
          }
        ).defaultThreadEnvMode,
      ).toBe("worktrunk");
      const updated = yield* projectEvent(readModel, { ...event, sequence: 2 });
      const project = updated.projects[0];
      expect(project?.defaultThreadEnvMode).toBe("worktree");
      expect(project?.defaultThreadEnvModeFork).toBe("worktrunk");
    }),
  );
});
