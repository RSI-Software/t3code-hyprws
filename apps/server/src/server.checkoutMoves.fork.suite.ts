// Fork-owned WebSocket cases for checkout moves. `server.test.ts` registers
// them inside its router seam suite through one hook, so they reuse its app
// harness without adding test blocks to the upstream file.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type * as NodeServices from "@effect/platform-node/NodeServices";
import type { Vitest } from "@effect/vitest";
import { assert } from "@effect/vitest";
import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CheckoutMoveHarnessFork } from "./server.test.ts";

export const checkoutMoveTestsFork = (
  it: Vitest.MethodsNonLive<NodeServices.NodeServices>,
  {
    buildAppUnderTest,
    getWsServerUrl,
    withWsRpcClient,
    makeDefaultOrchestrationThreadShell,
    defaultProjectId,
    defaultModelSelection,
  }: CheckoutMoveHarnessFork,
) => {
  it.effect("enriches checkout moves and enforces request and checkout identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkout-move-" });
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const commonDir = path.join(root, ".git");
      yield* Effect.all(
        [source, destination, commonDir].map((directory) =>
          fileSystem.makeDirectory(directory, { recursive: true }),
        ),
      );
      const threadId = ThreadId.make("thread-checkout-move-transport");
      const contextRevision = "2026-01-01T00:00:00.000Z";
      const dispatched: OrchestrationCommand[] = [];
      let thread = makeDefaultOrchestrationThreadShell({
        id: threadId,
        branch: "source",
        worktreePath: source,
        updatedAt: contextRevision,
      });
      const project = {
        id: defaultProjectId,
        title: "Checkout move",
        workspaceRoot: source,
        defaultModelSelection,
        scripts: [],
        createdAt: contextRevision,
        updatedAt: contextRevision,
        deletedAt: null,
      };

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            execute: ({ args, cwd }) =>
              Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: args.includes("--git-common-dir")
                  ? `${commonDir}\n`
                  : args[0] === "symbolic-ref"
                    ? `${cwd === source ? "source" : "destination"}\n`
                    : `${cwd === source ? "source-revision" : "destination-revision"}\n`,
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                if (command.type === "thread.checkout-move.prepare") {
                  thread = {
                    ...thread,
                    checkoutMove: {
                      requestId: command.requestId,
                      source: command.source,
                      sourceThreadBranch: command.sourceThreadBranch,
                      sourceThreadWorktreePath: command.sourceThreadWorktreePath,
                      requestedPath: command.destination.checkoutRoot,
                      destination: command.destination,
                      expectedCheckoutRoot: command.source.checkoutRoot,
                      status: command.queued ? "queued" : "preparing",
                      completedSteps: [],
                      effectiveProvider: null,
                      requestedAt: command.createdAt,
                      updatedAt: command.createdAt,
                    },
                  };
                }
                return { sequence: dispatched.length };
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [project],
                threads: [thread],
                updatedAt: thread.updatedAt,
              }),
            getThreadShellById: () => Effect.succeed(Option.some(thread)),
          },
        },
      });

      const request = {
        type: "thread.checkout-move.request" as const,
        commandId: CommandId.make("move-transport-1"),
        threadId,
        requestedPath: destination,
        expectedCheckoutRoot: source,
        createdAt: "2001-01-01T00:00:00.000Z",
      };
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](request);
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](request);
            const conflicting = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              ...request,
              requestedPath: source,
            }).pipe(Effect.result);
            assert.equal(conflicting._tag, "Failure");
            thread = { ...thread, updatedAt: "2026-01-01T00:00:01.000Z", checkoutMove: null };
            const afterMetadataUpdate = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              ...request,
              commandId: CommandId.make("move-transport-after-metadata-update"),
            });
            assert.equal(afterMetadataUpdate.sequence, 3);
          }),
        ),
      );

      assert.equal(dispatched[0]?.type, "thread.checkout-move.prepare");
      if (dispatched[0]?.type === "thread.checkout-move.prepare") {
        assert.equal(dispatched[0].source.checkoutRoot, source);
        assert.equal(dispatched[0].destination.checkoutRoot, destination);
        assert.notEqual(dispatched[0].createdAt, request.createdAt);
      }
      assert.equal(dispatched[1]?.type, "thread.checkout-move.request");
      assert.equal(dispatched.length, 3);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
};
