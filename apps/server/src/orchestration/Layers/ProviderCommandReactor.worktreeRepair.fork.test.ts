// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe } from "vite-plus/test";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "../../../integration/OrchestrationEngineHarness.integration.ts";

const PROJECT_ID = ProjectId.make("worktree-repair-project");
const THREAD_ID = ThreadId.make("worktree-repair-thread");
const MODEL_SELECTION = {
  instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
  model: DEFAULT_MODEL,
};
const NOW = "2026-09-05T00:00:00.000Z";

const turnStart = (tag: string, text: string) => ({
  type: "thread.turn.start" as const,
  commandId: CommandId.make(`worktree-repair-turn-${tag}`),
  threadId: THREAD_ID,
  message: {
    messageId: MessageId.make(`worktree-repair-message-${tag}`),
    role: "user" as const,
    text,
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required" as const,
  createdAt: NOW,
});

const OWNER_ID = ThreadId.make("worktree-repair-owner");

const ownerSession = (harness: OrchestrationIntegrationHarness, activeTurnId: TurnId | null) =>
  harness.engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`worktree-repair-owner-session-${activeTurnId ?? "idle"}`),
    threadId: OWNER_ID,
    session: {
      threadId: OWNER_ID,
      status: activeTurnId === null ? "ready" : "running",
      providerName: ProviderDriverKind.make("codex"),
      providerInstanceId: MODEL_SELECTION.instanceId,
      runtimeMode: "approval-required",
      activeTurnId,
      lastError: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
  });

describe("missing worktree repair", () => {
  it.live("stops turn start until a missing worktree is rebound", () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness(),
      (harness) =>
        Effect.gen(function* () {
          const worktreePath = NodePath.join(harness.rootDir, "deleted-worktree");
          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("worktree-repair-project-create"),
            projectId: PROJECT_ID,
            title: "Worktree repair project",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: MODEL_SELECTION,
            createdAt: NOW,
          });
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("worktree-repair-thread-create"),
            threadId: THREAD_ID,
            projectId: PROJECT_ID,
            title: "Worktree repair thread",
            modelSelection: MODEL_SELECTION,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: "feature/deleted",
            worktreePath,
            createdAt: NOW,
          });

          // Another thread's running turn holds the project root, so the
          // recovery move to the root fails too and the turn must stop.
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("worktree-repair-owner-create"),
            threadId: OWNER_ID,
            projectId: PROJECT_ID,
            title: "Root owner",
            modelSelection: MODEL_SELECTION,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: "main",
            worktreePath: null,
            createdAt: NOW,
          });
          yield* ownerSession(harness, TurnId.make("worktree-repair-owner-turn"));

          yield* harness.engine.dispatch(turnStart("deleted", "continue"));
          yield* harness.drainProviderCommand;

          const expectedDetail = `This thread's worktree no longer exists at ${worktreePath}, and T3 could not recreate branch 'feature/deleted'. Restore that worktree or select another branch for this thread, then retry.`;
          const failed = yield* harness.snapshotQuery.getThreadShellById(THREAD_ID);
          assert(Option.isSome(failed));
          assert.equal(failed.value.session?.status, "error");
          assert.equal(failed.value.session?.activeTurnId, null);
          assert.equal(failed.value.session?.lastError, expectedDetail);
          assert.equal((yield* harness.providerService.listSessions()).length, 0);

          yield* ownerSession(harness, null);
          yield* harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("worktree-repair-rebind"),
            threadId: THREAD_ID,
            branch: "main",
            worktreePath: null,
          });
          yield* harness.engine.dispatch(turnStart("rebound", "continue from main"));
          yield* harness.drainProviderCommand;

          const sessions = yield* harness.providerService.listSessions();
          assert.equal(sessions.length, 1);
          assert.equal(sessions[0]?.cwd, harness.workspaceDir);
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
