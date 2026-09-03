// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import {
  ApprovalRequestId,
  CHILD_ITEM_RENDER_JSON_MAX_BYTES,
  ChildItemRenderDetail,
  CodexSettings,
  EventId,
  ProviderDriverKind,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";
const encodeChildItemRenderDetailJson = Schema.encodeSync(
  Schema.fromJsonString(ChildItemRenderDetail),
);
const childItemRenderDetailBytes = (detail: ChildItemRenderDetail) =>
  new TextEncoder().encode(encodeChildItemRenderDetailJson(detail)).length;
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Layers/CodexAdapter.fork.test/CodexAdapter",
) {}
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
class FakeCodexRuntime implements CodexSessionRuntimeShape {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Fork sibling preserves the upstream file-local runtime harness unchanged.
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";
  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );
  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );
  public readonly interruptTurnImpl = vi.fn((_turnId?: TurnId): Promise<void> =>
    Promise.resolve(undefined),
  );
  public readonly readThreadImpl = vi.fn((): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );
  public readonly rollbackThreadImpl = vi.fn((_numTurns: number): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );
  public readonly uploadFeedbackImpl = vi.fn((_reason?: string) =>
    Promise.resolve({ threadId: "provider-thread-1" }),
  );
  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );
  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );
  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));
  readonly options: CodexSessionRuntimeOptions;
  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }
  start() {
    return Effect.promise(() => this.startImpl());
  }
  getSession = Effect.promise(() => this.startImpl());
  compactThread = Effect.void;
  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }
  interruptTurn(turnId?: TurnId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId));
  }
  readThread = Effect.promise(() => this.readThreadImpl());
  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }
  uploadFeedback(reason?: string) {
    return Effect.promise(() => this.uploadFeedbackImpl(reason));
  }
  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }
  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }
  get events() {
    return Stream.fromQueue(this.eventQueue);
  }
  close = Effect.promise(() => this.closeImpl());
  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}
function makeRuntimeFactory() {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });
  return {
    factory,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}
const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});
const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);
function startLifecycleRuntime(cwd?: string) {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
      ...(cwd ? { cwd } : {}),
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    return { adapter, runtime };
  });
}
lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("preserves Codex child item lifecycle as attributed item rows", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const detail = "child result ".repeat(40);
      const events: ProviderRuntimeEvent[] = [];
      for (const lifecycle of ["item.started", "item.updated", "item.completed"] as const) {
        const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        yield* runtime.emit({
          id: asEventId(`evt-child-${lifecycle}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "collabAgent/item",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          payload: {
            agentThreadId: "child-thread-1",
            agentPath: "/root/audit",
            lifecycle,
            item: {
              type: "agentMessage",
              id: "child-message-1",
              text: detail,
            },
          },
        });
        const event = yield* Fiber.join(eventFiber);
        NodeAssert.equal(event._tag, "Some");
        if (event._tag === "Some") {
          events.push(event.value);
        }
      }
      NodeAssert.deepStrictEqual(
        events.map((event) => event.type),
        ["item.started", "item.updated", "item.completed"],
      );
      for (const event of events) {
        if (
          event.type !== "item.started" &&
          event.type !== "item.updated" &&
          event.type !== "item.completed"
        ) {
          continue;
        }
        NodeAssert.equal(event.itemId, "child-message-1");
        NodeAssert.equal(event.payload.itemType, "assistant_message");
        NodeAssert.equal(event.payload.agentId, "child-thread-1");
        NodeAssert.equal(event.payload.timelineBypass, true);
        NodeAssert.equal(event.payload.detail?.length, 180);
      }
    }),
  );
  it.effect("normalizes bounded Codex child command results and file diffs", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime("/workspace/project");
      const collectChildItem = (id: string, item: Record<string, unknown>) =>
        Effect.gen(function* () {
          const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
          yield* runtime.emit({
            id: asEventId(id),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            createdAt: "2026-01-01T00:00:00.000Z",
            method: "collabAgent/item",
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-1"),
            payload: {
              agentThreadId: "child-thread-1",
              lifecycle: "item.completed",
              item,
            },
          });
          const event = yield* Fiber.join(eventFiber);
          NodeAssert.equal(event._tag, "Some");
          return event._tag === "Some" ? event.value : undefined;
        });
      const command = yield* collectChildItem("evt-child-command", {
        type: "commandExecution",
        id: "child-command-1",
        command: "cat /home/alice/private.txt",
        aggregatedOutput: `done\n${'\u0000\n"\\'.repeat(5000)}`,
      });
      const fileChange = yield* collectChildItem("evt-child-file", {
        type: "fileChange",
        id: "child-file-1",
        changes: [
          {
            path: "/workspace/project/src/example.ts",
            kind: { type: "update" },
            diff: "--- /home/alice/example.ts\n+++ src/example.ts\n+hello",
          },
          {
            path: "/workspace/other/private.ts",
            kind: { type: "add" },
            diff: "+secret",
          },
        ],
      });
      const mcp = yield* collectChildItem("evt-child-mcp", {
        type: "mcpToolCall",
        id: "child-mcp-1",
        server: "t3-code",
        tool: "child_result",
        arguments: {},
        status: "failed",
        result: {
          content: [{ type: "text", text: "MCP result" }],
          structuredContent: { output: "structured result" },
        },
      });
      const dynamic = yield* collectChildItem("evt-child-dynamic", {
        type: "dynamicToolCall",
        id: "child-dynamic-1",
        status: "declined",
        contentItems: [{ type: "inputText", text: "dynamic result" }],
      });
      if (command?.type === "item.completed") {
        NodeAssert.equal(command.payload.renderDetail?.command, "cat [local path]");
        NodeAssert.match(command.payload.renderDetail?.result ?? "", /^done\n/u);
        NodeAssert.equal(command.payload.renderDetail?.truncated, true);
        NodeAssert.ok(command.payload.renderDetail);
        NodeAssert.ok(
          childItemRenderDetailBytes(command.payload.renderDetail) <=
            CHILD_ITEM_RENDER_JSON_MAX_BYTES,
        );
      } else {
        NodeAssert.fail("expected completed Codex child command");
      }
      if (fileChange?.type === "item.completed") {
        NodeAssert.deepStrictEqual(fileChange.payload.renderDetail, {
          changedFiles: [
            {
              path: "src/example.ts",
              kind: "modified",
              diff: "--- [local path]\n+++ src/example.ts\n+hello",
            },
          ],
          truncated: true,
        });
      } else {
        NodeAssert.fail("expected completed Codex child file change");
      }
      if (mcp?.type === "item.completed") {
        NodeAssert.equal(mcp.payload.status, "failed");
        NodeAssert.equal(mcp.payload.renderDetail?.result, "MCP result\nstructured result");
      } else {
        NodeAssert.fail("expected completed Codex child MCP call");
      }
      if (dynamic?.type === "item.completed") {
        NodeAssert.equal(dynamic.payload.status, "declined");
        NodeAssert.equal(dynamic.payload.renderDetail?.result, "dynamic result");
      } else {
        NodeAssert.fail("expected completed Codex child dynamic call");
      }
    }),
  );
});
