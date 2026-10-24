import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import {
  ThreadGroupsServiceFork,
  threadGroupsServiceLiveFork,
} from "./ThreadGroupsService.fork.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const a = ThreadId.make("a");
const b = ThreadId.make("b");
const c = ThreadId.make("c");
const d = ThreadId.make("d");
const deleted = ThreadId.make("deleted");
const missing = ThreadId.make("missing");
const live = new Set([a, b, c, d]);

const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) =>
    Effect.succeed(
      live.has(threadId) || threadId === deleted
        ? ({
            deletedAt: live.has(threadId) ? null : "2026-01-01T00:00:00.000Z",
          } as never as OrchestrationV2ThreadShell)
        : null,
    ),
});

// Each `it.layer` block gets its own in-memory database; the service layer is
// rebuilt per test so a reload reads only what the table kept.
const database = it.layer(
  Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer, threads),
);
// The service loads its table on build, so the schema goes first.
const withService = <A, E>(effect: Effect.Effect<A, E, ThreadGroupsServiceFork>) =>
  Effect.andThen(ensureForkSchema(), Effect.provide(effect, threadGroupsServiceLiveFork));

database("ThreadGroupsServiceFork", (it) => {
  it.effect("persists membership across a reload and dissolves groups under two members", () =>
    Effect.gen(function* () {
      yield* withService(
        Effect.gen(function* () {
          const service = yield* ThreadGroupsServiceFork;
          yield* service.mutate({
            type: "set-membership",
            threadIds: [a, b],
            target: { type: "new", groupId: "g1", title: "Orchestrator", asParent: true },
          });
          yield* service.mutate({
            type: "set-membership",
            threadIds: [c],
            target: { type: "existing", groupId: "g1" },
          });
        }),
      );

      const reloaded = yield* withService(
        Effect.gen(function* () {
          const service = yield* ThreadGroupsServiceFork;
          const before = yield* service.snapshot;
          // The parent leaving stops it leading; the group keeps two members.
          const afterParentLeaves = yield* service.mutate({
            type: "set-membership",
            threadIds: [a],
            target: { type: "none" },
          });
          const dissolved = yield* service.mutate({
            type: "set-membership",
            threadIds: [b],
            target: { type: "none" },
          });
          return { before, afterParentLeaves, dissolved };
        }),
      );
      assert.deepStrictEqual(reloaded.before.groups, [
        { id: "g1", title: "Orchestrator", threadIds: [a, b, c], parentThreadId: a },
      ]);
      assert.deepStrictEqual(reloaded.afterParentLeaves.groups, [
        { id: "g1", title: "Orchestrator", threadIds: [b, c] },
      ]);
      assert.deepStrictEqual(reloaded.dissolved.groups, []);
    }),
  );
});

database("ThreadGroupsServiceFork validation", (it) => {
  it.effect("refuses unknown or deleted threads and notifies only committed changes", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* ThreadGroupsServiceFork;
        const seen = yield* service.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );

        for (const unknown of [missing, deleted]) {
          const refused = yield* service
            .mutate({
              type: "set-membership",
              threadIds: [a, unknown],
              target: { type: "new", title: "Nope" },
            })
            .pipe(Effect.exit);
          assert.ok(Exit.isFailure(refused));
        }
        // A rename against a stale expectation changes nothing and publishes nothing.
        yield* service.mutate({
          type: "set-membership",
          threadIds: [a, b],
          target: { type: "new", groupId: "g1", title: "Draft" },
        });
        yield* service.mutate({
          type: "rename",
          groupId: "g1",
          title: "Generated",
          expected: { title: "Other", threadIds: [a, b] },
        });

        const snapshots = Array.from(yield* Fiber.join(seen));
        assert.deepStrictEqual(
          snapshots.map((snapshot) => snapshot.groups.map((group) => group.title)),
          [[], ["Draft"]],
        );
      }),
    ),
  );
});

database("ThreadGroupsServiceFork import", (it) => {
  it.effect("imports local groups without stealing grouped or dead threads", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* ThreadGroupsServiceFork;
        yield* service.mutate({
          type: "set-membership",
          threadIds: [a, b],
          target: { type: "new", groupId: "g1", title: "Server" },
        });
        const imported = yield* service.mutate({
          type: "import",
          groups: [
            { id: "g1", title: "Same id", threadIds: [c, d] },
            { id: "g2", title: "Grouped or dead", threadIds: [b, c, deleted], parentThreadId: b },
            { id: "g3", title: "Local", threadIds: [c, missing, d], parentThreadId: missing },
          ],
        });
        assert.deepStrictEqual(imported.groups, [
          { id: "g1", title: "Server", threadIds: [a, b] },
          { id: "g3", title: "Local", threadIds: [c, d] },
        ]);
      }),
    ),
  );
});
