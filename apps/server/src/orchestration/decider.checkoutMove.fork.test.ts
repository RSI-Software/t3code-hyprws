import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CheckoutPhysicalIdentity,
  type OrchestrationReadModel,
  type ThreadCheckoutMove,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const contextRevision = "2026-09-05T08:00:00.000Z";
const source: CheckoutPhysicalIdentity = {
  repositoryRoot: "/repo",
  checkoutRoot: "/repo/source",
  revision: "source-sha",
  branch: "source",
};
const destination: CheckoutPhysicalIdentity = {
  repositoryRoot: "/repo",
  checkoutRoot: "/repo/destination",
  revision: "destination-sha",
  branch: "destination",
};

function readModel(
  checkoutMove: ThreadCheckoutMove | null = null,
  updatedAt = contextRevision,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-checkout-move"),
        projectId: ProjectId.make("project-checkout-move"),
        title: "Checkout move",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: source.branch,
        worktreePath: source.checkoutRoot,
        latestTurn: null,
        createdAt: contextRevision,
        updatedAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        checkoutMove,
      },
    ],
    updatedAt: contextRevision,
  };
}

const prepare = {
  type: "thread.checkout-move.prepare" as const,
  commandId: CommandId.make("prepare-checkout-move"),
  threadId: ThreadId.make("thread-checkout-move"),
  requestId: CommandId.make("request-checkout-move"),
  source,
  sourceThreadBranch: source.branch,
  sourceThreadWorktreePath: source.checkoutRoot,
  destination,
  queued: false,
  createdAt: "2026-09-05T08:00:01.000Z",
};

it.layer(NodeServices.layer)("checkout move decider", (it) => {
  it.effect("accepts unrelated thread updates after server enrichment", () =>
    Effect.gen(function* () {
      const stale = readModel(null, "2026-09-05T08:00:02.000Z");
      const event = yield* decideOrchestrationCommand({ command: prepare, readModel: stale });
      const events = "type" in event ? [event] : event;
      expect(events[0]?.type).toBe("thread.checkout-move-updated");
    }),
  );

  it.effect("rejects changed checkout context after server enrichment", () =>
    Effect.gen(function* () {
      const current = readModel();
      const stale = {
        ...current,
        threads: current.threads.map((thread) => ({ ...thread, worktreePath: "/repo/other" })),
      };
      const error = yield* decideOrchestrationCommand({ command: prepare, readModel: stale }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: "checkout move context changed before command commit",
      });
    }),
  );

  it.effect("accepts only the checked reverse of the latest committed move", () =>
    Effect.gen(function* () {
      const priorRequestId = CommandId.make("prior-checkout-move");
      const committed: ThreadCheckoutMove = {
        requestId: priorRequestId,
        source: destination,
        sourceThreadBranch: destination.branch,
        sourceThreadWorktreePath: destination.checkoutRoot,
        requestedPath: source.checkoutRoot,
        destination: source,
        expectedCheckoutRoot: destination.checkoutRoot,
        status: "committed",
        completedSteps: ["provider", "metadata"],
        effectiveProvider: source,
        providerAvailable: true,
        requestedAt: contextRevision,
        updatedAt: contextRevision,
      };
      const reverse = {
        ...prepare,
        source,
        destination,
        reverseOfRequestId: priorRequestId,
      };
      const accepted = yield* decideOrchestrationCommand({
        command: reverse,
        readModel: readModel(committed),
      });
      const event = Array.isArray(accepted) ? accepted[0] : accepted;
      expect(event && "type" in event ? event.type : undefined).toBe(
        "thread.checkout-move-updated",
      );
      const error = yield* decideOrchestrationCommand({
        command: { ...reverse, reverseOfRequestId: CommandId.make("not-latest") },
        readModel: readModel(committed),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: "reverse move no longer matches the effective checkout",
      });
    }),
  );
});
