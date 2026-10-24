import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";
import { McpServer } from "effect/ai";

import {
  ThreadGroupsServiceFork,
  threadGroupsServiceLiveFork,
} from "../../../orchestration-v2/ThreadGroupsService.fork.ts";
import { ensureForkSchema } from "../../../persistence/ForkSchema.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { prepareLaunchGroupFork, ThreadGroupsToolkitHandlersLiveFork } from "./handlers.fork.ts";
import { ThreadGroupsToolkitFork } from "./tools.fork.ts";

const orchestrator = ThreadId.make("orchestrator");
const first = ThreadId.make("first");
const second = ThreadId.make("second");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session:provider-session-1",
  thread: {
    threadId: orchestrator,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

// Every thread is live and titled by its id; each test gets a fresh database.
const services = threadGroupsServiceLiveFork.pipe(
  Layer.provide(Layer.effectDiscard(ensureForkSchema())),
  Layer.provideMerge(
    Layer.mergeAll(
      NodeSqliteClient.layer({ filename: ":memory:" }),
      NodeCrypto.layer,
      McpToolAccessTestkit.liveThreadsLayer,
    ),
  ),
);

const call = <Name extends keyof typeof ThreadGroupsToolkitFork.tools>(
  name: Name,
  params: Tool.Parameters<(typeof ThreadGroupsToolkitFork.tools)[Name]>,
) =>
  ThreadGroupsToolkitFork.pipe(
    Effect.flatMap((toolkit) => toolkit.handle(name, params as never)),
    Stream.unwrap,
    Stream.runCollect,
    Effect.map(
      (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ThreadGroupsToolkitFork.tools)[Name]>,
    ),
    Effect.provide(McpToolAccess.HandlersLayer.layer(ThreadGroupsToolkitHandlersLiveFork)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
  );

const startGroup = ThreadGroupsServiceFork.pipe(
  Effect.flatMap((groups) =>
    groups.mutate({
      type: "set-membership",
      threadIds: [orchestrator, first],
      target: { type: "new", groupId: "g1", title: "Work", asParent: true },
    }),
  ),
);

it.effect("agents move threads into the caller's group and list it by name", () =>
  Effect.gen(function* () {
    yield* startGroup;
    yield* call("t3_thread_group_update", {
      edit: {
        type: "set-membership",
        threadIds: [second],
        target: { type: "existing", groupId: "g1" },
      },
    });
    assert.deepStrictEqual(yield* call("t3_thread_group_list", {}), {
      groups: [
        {
          id: "g1",
          title: "Work",
          parentThreadId: orchestrator,
          threads: [orchestrator, first, second].map((threadId) => ({ threadId, title: threadId })),
        },
      ],
      callerGroupId: "g1",
    });
  }).pipe(Effect.provide(services)),
);

it.effect("launches join the caller's group by default and refuse an unknown group", () =>
  Effect.gen(function* () {
    yield* startGroup;
    const groups = yield* ThreadGroupsServiceFork;
    const ungrouped = yield* prepareLaunchGroupFork(orchestrator, "none");
    yield* ungrouped([{ threadId: second }]);
    assert.strictEqual(yield* groups.groupOf(second), undefined);

    const joinCaller = yield* prepareLaunchGroupFork(orchestrator, undefined);
    const rolledBack = ThreadId.make("rolled-back");
    yield* joinCaller([{ threadId: second }, { threadId: rolledBack, status: "rolled_back" }]);
    assert.deepStrictEqual((yield* groups.groupOf(second))?.threadIds, [
      orchestrator,
      first,
      second,
    ]);

    const unknown = yield* prepareLaunchGroupFork(orchestrator, { groupId: "gone" }).pipe(
      Effect.exit,
    );
    assert.ok(Exit.isFailure(unknown));
  }).pipe(Effect.provide(services)),
);

// MCP refuses a tool whose parameters lack an object root, crashing startup.
it.effect("registers with an MCP server", () =>
  Effect.void.pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(
        ThreadGroupsToolkitFork,
        ThreadGroupsToolkitHandlersLiveFork,
      ).pipe(Layer.provideMerge(McpServer.McpServer.layer), Layer.provideMerge(services)),
    ),
  ),
);
