// Fork-owned WebSocket cases for binding a bootstrap worktree to its managed
// zmux session. `server.test.ts` registers them inside its router seam suite
// through one hook, so they reuse its app harness without adding test blocks
// to the upstream file.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type * as NodeServices from "@effect/platform-node/NodeServices";
import type { Vitest } from "@effect/vitest";
import { assert } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import type { ZmuxBootstrapHarnessFork } from "./server.test.ts";

export const zmuxBootstrapTestsFork = (
  it: Vitest.MethodsNonLive<NodeServices.NodeServices>,
  {
    buildAppUnderTest,
    getWsServerUrl,
    withWsRpcClient,
    defaultModelSelection,
    defaultProjectId,
    SUCCESSFUL_GIT_EXECUTION,
  }: ZmuxBootstrapHarnessFork,
) => {
  it.effect("attempts to bind a bootstrap worktree and records failures as activity", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const bind = vi.fn((_worktreePath: string) =>
        Effect.succeed({
          status: "failed" as const,
          notice: {
            summary: "zmux session failed to bind",
            detail: "branch_conflict: branch is already bound",
          },
        }),
      );

      yield* buildAppUnderTest({
        layers: {
          // Upstream's tracked-bootstrap flow only prepares a worktree in a real
          // repository whose base resolves; stand both gates in so the fork's
          // zmux bind at the created worktree stays under test.
          vcsDriver: { isInsideWorkTree: () => Effect.succeed(true) },
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            createWorktree: () =>
              Effect.succeed({
                worktree: {
                  refName: "t3code/bootstrap-refName",
                  path: "/tmp/bootstrap-worktree",
                },
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          zmuxSessionBinder: { bind },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-zmux-bind"),
            threadId: ThreadId.make("thread-bootstrap-zmux-bind"),
            message: {
              messageId: MessageId.make("msg-bootstrap-zmux-bind"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-refName",
              },
            },
            createdAt,
          }),
        ),
      );

      assert.deepStrictEqual(bind.mock.calls[0], [
        "/tmp/bootstrap-worktree",
        { projectPath: "/tmp/project" },
      ]);
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.message.user.append",
          "thread.activity.append",
          "thread.session.set",
          "thread.activity.append",
          "thread.meta.update",
          "thread.turn.start",
          "thread.activity.append",
        ],
      );
      // Target's bootstrap projects its own setup activities around the fork's
      // zmux bind record; pick the bind failure by kind, not by position.
      const bindFailureActivity = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "zmux-session.failed",
      );
      assert.equal(bindFailureActivity?.activity.kind, "zmux-session.failed");
      assert.deepStrictEqual(bindFailureActivity?.activity.payload, {
        detail: "branch_conflict: branch is already bound",
        worktreePath: "/tmp/bootstrap-worktree",
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records the verified zmux adoption outcome on the bootstrap thread", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const bind = vi.fn((_worktreePath: string) =>
        Effect.succeed({
          status: "bound" as const,
          target: "project/t3code-bootstrap-refName",
          outcome: "reused" as const,
        }),
      );

      yield* buildAppUnderTest({
        layers: {
          // Upstream's tracked-bootstrap flow only prepares a worktree in a real
          // repository whose base resolves; stand both gates in so the fork's
          // zmux bind at the created worktree stays under test.
          vcsDriver: { isInsideWorkTree: () => Effect.succeed(true) },
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            createWorktree: () =>
              Effect.succeed({
                worktree: {
                  refName: "t3code/bootstrap-refName",
                  path: "/tmp/bootstrap-worktree",
                },
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          zmuxSessionBinder: { bind },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-zmux-bound"),
            threadId: ThreadId.make("thread-bootstrap-zmux-bound"),
            message: {
              messageId: MessageId.make("msg-bootstrap-zmux-bound"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-refName",
              },
            },
            createdAt,
          }),
        ),
      );

      assert.deepStrictEqual(bind.mock.calls[0]?.[0], "/tmp/bootstrap-worktree");
      // Target's bootstrap projects its own setup activities around the fork's
      // zmux bind record; pick the bind outcome by kind, not by position.
      const bindActivity = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "zmux-session.bound",
      );
      assert.equal(bindActivity?.activity.kind, "zmux-session.bound");
      assert.equal(bindActivity?.activity.summary, "zmux session reused");
      assert.equal(bindActivity?.activity.tone, "info");
      assert.deepStrictEqual(bindActivity?.activity.payload, {
        outcome: "reused",
        target: "project/t3code-bootstrap-refName",
        worktreePath: "/tmp/bootstrap-worktree",
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
};
