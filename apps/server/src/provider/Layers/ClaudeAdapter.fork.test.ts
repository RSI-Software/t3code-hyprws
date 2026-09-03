// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  CHILD_ITEM_RENDER_JSON_MAX_BYTES,
  CHILD_ITEM_RENDER_DIFF_MAX_CHARS,
  ChildItemRenderDetail,
  ClaudeSettings,
  ProviderDriverKind,
  ProviderItemId,
  ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../ClaudeModelCatalog.testFixtures.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../Errors.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapter, type ClaudeAdapterLiveOptions } from "./ClaudeAdapter.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeChildItemRenderDetailJson = Schema.encodeSync(
  Schema.fromJsonString(ChildItemRenderDetail),
);
const childItemRenderDetailBytes = (detail: ChildItemRenderDetail) =>
  new TextEncoder().encode(encodeChildItemRenderDetailJson(detail)).length;
// Test-local service tag so the rest of the file can keep using `yield* ClaudeAdapter`.
class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Layers/ClaudeAdapter.fork.test/ClaudeAdapter",
) {}
class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public closeCalls = 0;
  public closeError: unknown | undefined;
  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }
  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }
  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };
  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };
  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };
  readonly close = (): void => {
    this.closeCalls += 1;
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
    this.finish();
  };
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}
function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly claudeConfig?: Partial<ClaudeSettings>;
  readonly instanceId?: ProviderInstanceId;
}) {
  const query = new FakeClaudeQuery();
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;
  const adapterOptions: ClaudeAdapterLiveOptions = {
    ...(config?.instanceId ? { instanceId: config.instanceId } : {}),
    modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    createQuery: (input) => {
      createInput = input;
      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };
  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings(config?.claudeConfig ?? {});
        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}
function makeDeterministicRandomService(seed = 305419896): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 4294967296,
  };
}
async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}
async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}
const THREAD_ID = ThreadId.make("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.make("thread-claude-resume");
const SYNTHETIC_SUBAGENT_MODEL = "claude-synthetic-subagent[expanded]";
describe("ClaudeAdapterLive", () => {
  it.effect("launches the selected Claude custom agent as the main session", () => {
    const harness = makeHarness({ claudeConfig: { launchArgs: "--agent legacy --verbose" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [{ id: "agent", value: "fable" }],
        ),
        runtimeMode: "full-access",
      });
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.extraArgs, {
        agent: "fable",
        verbose: null,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  it.effect("removes a configured Claude agent when Default is selected", () => {
    const harness = makeHarness({ claudeConfig: { launchArgs: "--agent legacy --verbose" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [{ id: "agent", value: "default" }],
        ),
        runtimeMode: "full-access",
      });
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.extraArgs, { verbose: null });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  it.effect("persists bounded child assistant text under task_id without a synthetic turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const itemEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "item.completed" && event.payload.agentId === "task-child-text",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      // Replay can deliver the completed child snapshot before task_started.
      // Buffer by tool-use id, then publish with task_id as the durable agent id.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_child_text",
        message: {
          id: "assistant-child-text",
          model: "claude-sonnet-5[1m]",
          content: [{ type: "text", text: "child answer ".repeat(40) }],
        },
        uuid: "assistant-child-text-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-child-text",
        description: "Text agent",
        task_type: "local_agent",
        tool_use_id: "toolu_child_text",
        uuid: "task-child-text-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      const itemEvent = yield* Fiber.join(itemEventFiber);
      assert.equal(itemEvent._tag, "Some");
      if (itemEvent._tag !== "Some" || itemEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(itemEvent.value.itemId, "assistant-child-text");
      assert.equal(itemEvent.value.turnId, undefined);
      assert.equal(itemEvent.value.payload.itemType, "assistant_message");
      assert.equal(itemEvent.value.payload.agentId, "task-child-text");
      assert.equal(itemEvent.value.payload.parentToolUseId, "toolu_child_text");
      assert.equal(itemEvent.value.payload.timelineBypass, true);
      assert.equal(itemEvent.value.payload.detail?.length, 180);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  it.effect("keeps every child tool lifecycle row attributed and off the parent timeline", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const toolEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed") &&
            event.payload.agentId === "task-child-tool",
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-child-tool",
        description: "Tool agent",
        task_type: "local_agent",
        tool_use_id: "toolu_child_agent",
        uuid: "task-child-tool-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        parent_tool_use_id: "toolu_child_agent",
        uuid: "child-tool-start",
        session_id: "sdk-session",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "child-tool-1",
            name: "Read",
            input: { file_path: "src/example.ts" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        parent_tool_use_id: "toolu_child_agent",
        uuid: "child-tool-result",
        session_id: "sdk-session",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "child-tool-1",
              content: "file contents",
            },
          ],
        },
      } as unknown as SDKMessage);
      const events = Array.from(yield* Fiber.join(toolEventsFiber));
      assert.deepEqual(
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
        assert.equal(event.itemId, "child-tool-1");
        assert.equal(event.payload.agentId, "task-child-tool");
        assert.equal(event.payload.parentToolUseId, "toolu_child_agent");
        assert.equal(event.payload.timelineBypass, true);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  it.effect("normalizes bounded Claude child command results and file diffs", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "item.completed" && event.payload.agentId === "task-child-detail",
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        cwd: "/workspace/project",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-child-detail",
        description: "Detail agent",
        task_type: "local_agent",
        tool_use_id: "toolu_child_detail",
        uuid: "task-child-detail-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      const emitTool = (
        index: number,
        id: string,
        name: string,
        input: object,
        result: string,
        toolUseResult?: object,
      ) => {
        harness.query.emit({
          type: "stream_event",
          parent_tool_use_id: "toolu_child_detail",
          uuid: `${id}-start`,
          session_id: "sdk-session",
          event: {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id, name, input },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "user",
          parent_tool_use_id: "toolu_child_detail",
          uuid: `${id}-result`,
          session_id: "sdk-session",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: result }],
          },
          ...(toolUseResult ? { tool_use_result: toolUseResult } : {}),
        } as unknown as SDKMessage);
      };
      emitTool(
        0,
        "child-command-detail",
        "Bash",
        { command: "cat /home/alice/private.txt" },
        `done\n${'\u0000\n"\\'.repeat(5000)}`,
      );
      emitTool(
        1,
        "child-edit-detail",
        "Edit",
        {
          file_path: "/workspace/project/src/example.ts",
          old_string: "const home = '/home/alice';",
          new_string: "const home = './project';",
        },
        "updated /home/alice/project/src/example.ts",
      );
      emitTool(2, "child-mcp-detail", "mcp__example__run", {}, "ok", {
        output: "richer structured output",
        runHandles: { taskId: "private-task-id" },
      });
      const events = Array.from(yield* Fiber.join(completedFiber));
      const command = events.find((event) => event.itemId === "child-command-detail");
      const edit = events.find((event) => event.itemId === "child-edit-detail");
      const mcp = events.find((event) => event.itemId === "child-mcp-detail");
      if (command?.type === "item.completed") {
        assert.equal(command.payload.renderDetail?.command, "cat [local path]");
        assert.match(command.payload.renderDetail?.result ?? "", /^done\n/u);
        assert.equal(command.payload.renderDetail?.truncated, true);
        assert.ok(command.payload.renderDetail);
        assert.ok(
          childItemRenderDetailBytes(command.payload.renderDetail) <=
            CHILD_ITEM_RENDER_JSON_MAX_BYTES,
        );
      } else {
        assert.fail("expected completed Claude child command");
      }
      if (edit?.type === "item.completed") {
        assert.deepEqual(edit.payload.renderDetail, {
          result: "updated [local path]",
          changedFiles: [
            {
              path: "src/example.ts",
              kind: "modified",
              diff: "--- before\n+++ after\n-const home = '[local path]';\n+const home = './project';",
            },
          ],
          truncated: true,
        });
      } else {
        assert.fail("expected completed Claude child edit");
      }
      if (mcp?.type === "item.completed") {
        assert.equal(mcp.payload.renderDetail?.result, "richer structured output");
        assert.equal(mcp.payload.renderDetail?.result?.includes("private-task-id"), false);
      } else {
        assert.fail("expected completed Claude child MCP call");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
  it.effect(
    "renders attributed command and notebook input received only through JSON deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const updatesFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "item.updated" && event.payload.agentId === "task-child-delta",
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          cwd: "/workspace/project",
        });
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-child-delta",
          description: "Delta detail agent",
          task_type: "local_agent",
          tool_use_id: "toolu_child_delta",
          uuid: "task-child-delta-uuid",
          session_id: "sdk-session",
        } as unknown as SDKMessage);
        const emitDeltaTool = (index: number, id: string, name: string, partialJson: string) => {
          harness.query.emit({
            type: "stream_event",
            parent_tool_use_id: "toolu_child_delta",
            uuid: `${id}-start`,
            session_id: "sdk-session",
            event: {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id, name, input: {} },
            },
          } as unknown as SDKMessage);
          harness.query.emit({
            type: "stream_event",
            parent_tool_use_id: "toolu_child_delta",
            uuid: `${id}-delta`,
            session_id: "sdk-session",
            event: {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: partialJson },
            },
          } as unknown as SDKMessage);
        };
        emitDeltaTool(
          0,
          "child-command-delta",
          "Bash",
          '{"command":"cat /workspace/project/src/example.ts"}',
        );
        emitDeltaTool(
          1,
          "child-notebook-delta",
          "NotebookEdit",
          `{"notebook_path":"/workspace/project/notebooks/demo.ipynb","new_source":"${"x".repeat(5000)}"}`,
        );
        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const command = updates.find((event) => event.itemId === "child-command-delta");
        const notebook = updates.find((event) => event.itemId === "child-notebook-delta");
        if (command?.type === "item.updated") {
          assert.equal(command.payload.timelineBypass, true);
          assert.deepEqual(command.payload.renderDetail, {
            command: "cat [local path]",
            truncated: true,
          });
        } else {
          assert.fail("expected delta-only Claude child command update");
        }
        if (notebook?.type === "item.updated") {
          assert.equal(notebook.payload.timelineBypass, true);
          assert.equal(
            notebook.payload.renderDetail?.changedFiles?.[0]?.path,
            "notebooks/demo.ipynb",
          );
          assert.equal(notebook.payload.renderDetail?.changedFiles?.[0]?.kind, "modified");
          const diff = notebook.payload.renderDetail?.changedFiles?.[0]?.diff;
          assert.match(diff ?? "", /^--- before\n\+\+\+ after\n\+x+…$/u);
          assert.ok(diff);
          assert.ok(new TextEncoder().encode(diff).length <= CHILD_ITEM_RENDER_DIFF_MAX_CHARS);
          assert.equal(notebook.payload.renderDetail?.truncated, true);
        } else {
          assert.fail("expected delta-only Claude child notebook update");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});
