import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The Effect test clock starts at the epoch.
const BEFORE_NOW = "1969-12-30T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

const reorderCommand = {
  type: "thread.active.reorder",
  commandId: CommandId.make("cmd-active-reorder"),
  threadId: THREAD_ID,
  orderKey: "m",
} as const;

it.layer(NodeServices.layer)("active thread ordering reset (fork)", (it) => {
  it.effect("clears the manual slot on a null reorder without touching timestamps", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ activeOrderKey: "m", unsettledAt: BEFORE_NOW });
      const decided = yield* decideOrchestrationCommand({
        command: { ...reorderCommand, orderKey: null },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.meta-updated",
        payload: { threadId: THREAD_ID, activeOrderKey: null, updatedAt: NOW },
      });
      for (const event of events) {
        const projected = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
        expect(projected.threads[0]).toMatchObject({
          activeOrderKey: null,
          updatedAt: NOW,
          unsettledAt: BEFORE_NOW,
        });
      }
    }),
  );

  it.effect("rejects a null reorder on a settled thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: { ...reorderCommand, orderKey: null },
        readModel: makeReadModel({ settledOverride: "settled", settledAt: NOW }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
