// Fork-only: `thread.fork` handler tests. Happy paths assert the dispatch
// order per provider (binding insert-ignore → thread.create →
// thread.history.import → thread.unsettle) and that the parent binding is
// never rewritten; guard cases cover every tagged refusal.
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import * as NodePath from "@effect/platform-node/NodePath";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkThreadSource } from "./ThreadFork.fork.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claude-1");

// Counter-fed bytes so every generated uuid is distinct within a test.
let cryptoByte = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    const out = new Uint8Array(size);
    for (let index = 0; index < size; index++) out[index] = (cryptoByte += 7) & 0xff;
    return out;
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt = "2026-08-20T00:00:00.000Z",
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeActivity(kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("event-1"),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

const COMPLETED_TURN: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn-9"),
  state: "completed",
  requestedAt: "2026-08-20T00:00:00.000Z",
  startedAt: "2026-08-20T00:00:01.000Z",
  completedAt: "2026-08-20T00:00:02.000Z",
  assistantMessageId: MessageId.make("thread-1:000002"),
};

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: COMPLETED_TURN,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      makeMessage("thread-1:000001", "user", "hello"),
      makeMessage("thread-1:000002", "assistant", "hi there"),
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

const CODEX_BINDING = {
  threadId: THREAD_ID,
  provider: "codex" as const,
  providerInstanceId: INSTANCE_ID,
  status: "stopped" as const,
  resumeCursor: { threadId: "codex-native-1" },
  runtimePayload: { cwd: "/workspace/project" },
};

const CLAUDE_BINDING = {
  threadId: THREAD_ID,
  provider: "claudeAgent" as const,
  providerInstanceId: CLAUDE_INSTANCE_ID,
  status: "stopped" as const,
  resumeCursor: {
    resume: "0f0e0d0c-0b0a-4918-8a2b-3c4d5e6f7a8b",
    turnCount: 2,
    turnStartMessageIds: ["old-1", "old-2"],
  },
  runtimePayload: { cwd: "/workspace/project" },
};

const claudeSettingsLayer = Layer.mock(ServerSettingsService)({
  getSettings: Effect.succeed({
    providerInstances: {
      [CLAUDE_INSTANCE_ID]: { driver: "claudeAgent", config: { homePath: "/tmp/claude-home" } },
    },
    providers: {},
  }) as Effect.Effect<ServerSettings, never, never>,
});

/**
 * A default Claude instance that exists only through the legacy
 * `providers.claudeAgent` blob — absent from `settings.providerInstances`,
 * exactly like a deployment that never opened the instances UI.
 */
const defaultClaudeSettingsLayer = Layer.mock(ServerSettingsService)({
  getSettings: Effect.succeed({
    providerInstances: {},
    providers: { claudeAgent: { enabled: true, homePath: "/tmp/default-claude-home" } },
  }) as Effect.Effect<ServerSettings, never, never>,
});

const CLAUDE_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

const silentSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
);

/** A spawner answering the history worker's two methods with fixed payloads. */
const historySpawnerLayer = (responses: {
  readonly forkSession: string;
  readonly getSessionMessages: string;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(
            new TextEncoder().encode(
              (command as unknown as { readonly args: ReadonlyArray<string> }).args.includes(
                "forkSession",
              )
                ? responses.forkSession
                : responses.getSessionMessages,
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );

interface Harness {
  readonly commands: Ref.Ref<OrchestrationCommand[]>;
  readonly upserts: Ref.Ref<ProviderSessionDirectory.ProviderRuntimeBinding[]>;
  readonly options: Ref.Ref<Array<string | undefined>>;
}

const makeHarness = Effect.fn("makeThreadForkHarness")(function* (input: {
  readonly thread: OrchestrationThread;
  readonly binding?:
    | typeof CODEX_BINDING
    | typeof CLAUDE_BINDING
    | (typeof CODEX_BINDING & { readonly provider: string })
    | null;
  readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly settingsLayer?: Layer.Layer<ServerSettingsService>;
}) {
  const commands = yield* Ref.make<OrchestrationCommand[]>([]);
  const upserts = yield* Ref.make<ProviderSessionDirectory.ProviderRuntimeBinding[]>([]);
  const options = yield* Ref.make<Array<string | undefined>>([]);

  const layer = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: () => Effect.succeed(Option.some(input.thread)),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({ id: PROJECT_ID, workspaceRoot: "/workspace/project" }) as never,
        ),
    }),
    Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
      getBinding: (threadId: ThreadId) =>
        Effect.succeed(
          threadId === THREAD_ID && input.binding
            ? Option.some(input.binding as never)
            : Option.none(),
        ),
      upsert: (binding: ProviderSessionDirectory.ProviderRuntimeBinding, upsertOptions) =>
        Effect.asVoid(
          Effect.all([
            Ref.update(upserts, (list) => [...list, binding]),
            Ref.update(options, (list) => [...list, upsertOptions?.onConflict]),
          ]),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(commands, (list) => [...list, command]).pipe(Effect.as({ sequence: 1 })),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    input.spawnerLayer ?? silentSpawnerLayer,
    Layer.succeed(HostProcessIsExecutable, true),
    input.settingsLayer ?? claudeSettingsLayer,
    NodePath.layer,
  );

  const fork = () =>
    forkThreadSource({ threadId: THREAD_ID }).pipe(Effect.provide(layer)) as Effect.Effect<
      { readonly childThreadId: ThreadId },
      { readonly _tag: string; readonly reason?: string },
      never
    >;

  return { commands, upserts, options, fork } satisfies Harness & {
    readonly fork: () => ReturnType<typeof fork>;
  };
});

const CLONE_FORK_RESPONSE = JSON.stringify({
  sessionId: "e5f6a7b8-5555-4666-8777-888899990000",
});

const cloneHistory = (turnIds: ReadonlyArray<string>) =>
  JSON.stringify([
    { type: "user", uuid: turnIds[0], parent_tool_use_id: null, message: { content: "hi" } },
    {
      type: "assistant",
      uuid: "c3d4e5f6-3333-4444-8555-666677778888",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "user",
      uuid: "d4e5f6a7-4444-4555-8666-777788889999",
      parent_tool_use_id: "tool-1",
      message: { content: [{ type: "tool_result" }] },
    },
    { type: "user", uuid: turnIds[1], parent_tool_use_id: null, message: { content: "go" } },
  ]);

describe("forkThreadSource", () => {
  it.effect(
    "codex: installs the cutoff cursor, imports history, unsettles, leaves the parent alone",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ thread: makeThread(), binding: CODEX_BINDING });
        const { childThreadId } = yield* harness.fork();
        expect(childThreadId.startsWith(`import:${INSTANCE_ID}:fork-`)).toBe(true);

        const upserts = yield* Ref.get(harness.upserts);
        expect(upserts).toHaveLength(1);
        expect(upserts[0]?.provider).toBe("codex");
        expect(upserts[0]?.status).toBe("stopped");
        expect(upserts[0]?.runtimePayload).toEqual({ cwd: "/workspace/project" });
        // The captured cutoff: parent native thread + the completed turn id.
        expect(upserts[0]?.resumeCursor).toEqual({
          threadId: "codex-native-1",
          forkFrom: { lastTurnId: "turn-9" },
        });
        expect(yield* Ref.get(harness.options)).toEqual(["ignore"]);

        const commands = yield* Ref.get(harness.commands);
        expect(commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.history.import",
          "thread.unsettle",
        ]);
        expect(commands[0]).toMatchObject({
          threadId: childThreadId,
          projectId: PROJECT_ID,
          title: "Thread (fork)",
          historyImport: true,
          modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5" },
        });
        expect(
          (commands[1] as { messages: ReadonlyArray<{ messageId: string; role: string }> })
            .messages,
        ).toEqual([
          {
            messageId: `${childThreadId}:000000`,
            role: "user",
            text: "hello",
            createdAt: "2026-08-20T00:00:00.000Z",
          },
          {
            messageId: `${childThreadId}:000001`,
            role: "assistant",
            text: "hi there",
            createdAt: "2026-08-20T00:00:00.000Z",
          },
        ]);
        expect(commands[2]).toMatchObject({ threadId: childThreadId, reason: "user" });
        expect(new Set(commands.map((command) => command.commandId)).size).toBe(commands.length);

        // The parent's binding was read, never written.
        expect(upserts.some((upsert) => upsert.threadId === THREAD_ID)).toBe(false);
      }),
  );

  it.effect("claude: eager fork seeds the child cursor from the clone's human-prompt UUIDs", () =>
    Effect.gen(function* () {
      const cloneTurnIds = [
        "a1b2c3d4-1111-4222-8333-444455556666",
        "b2c3d4e5-2222-4333-8444-555566667777",
      ];
      const harness = yield* makeHarness({
        thread: makeThread({
          modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-sonnet" },
        }),
        binding: CLAUDE_BINDING,
        spawnerLayer: historySpawnerLayer({
          forkSession: CLONE_FORK_RESPONSE,
          getSessionMessages: cloneHistory(cloneTurnIds),
        }),
      });
      const { childThreadId } = yield* harness.fork();
      expect(childThreadId.startsWith(`import:${CLAUDE_INSTANCE_ID}:fork-`)).toBe(true);

      const upserts = yield* Ref.get(harness.upserts);
      expect(upserts).toHaveLength(1);
      expect(upserts[0]?.provider).toBe("claudeAgent");
      // Native forks rewrite UUIDs: boundaries come from the CLONE, and the
      // tool-result user row is not a turn start, so exactly two remain.
      expect(upserts[0]?.resumeCursor).toEqual({
        threadId: childThreadId,
        resume: "e5f6a7b8-5555-4666-8777-888899990000",
        turnCount: 2,
        turnStartMessageIds: cloneTurnIds,
      });
      expect(upserts.some((upsert) => upsert.threadId === THREAD_ID)).toBe(false);
      const commands = yield* Ref.get(harness.commands);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.history.import",
        "thread.unsettle",
      ]);
    }),
  );

  it.effect("claude: resolves a default instance that is absent from providerInstances", () =>
    Effect.gen(function* () {
      const cloneTurnIds = [
        "a1b2c3d4-1111-4222-8333-444455556666",
        "b2c3d4e5-2222-4333-8444-555566667777",
      ];
      const harness = yield* makeHarness({
        thread: makeThread({
          modelSelection: { instanceId: CLAUDE_DEFAULT_INSTANCE_ID, model: "claude-sonnet" },
        }),
        binding: {
          ...CLAUDE_BINDING,
          providerInstanceId: CLAUDE_DEFAULT_INSTANCE_ID,
        },
        spawnerLayer: historySpawnerLayer({
          forkSession: CLONE_FORK_RESPONSE,
          getSessionMessages: cloneHistory(cloneTurnIds),
        }),
        settingsLayer: defaultClaudeSettingsLayer,
      });
      const { childThreadId } = yield* harness.fork();
      expect(childThreadId.startsWith(`import:${CLAUDE_DEFAULT_INSTANCE_ID}:fork-`)).toBe(true);
      const upserts = yield* Ref.get(harness.upserts);
      expect(upserts).toHaveLength(1);
      expect(upserts[0]?.provider).toBe("claudeAgent");
    }),
  );

  it.effect("refuses a non-forkable provider", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread(),
        binding: { ...CODEX_BINDING, provider: "opencode" as never },
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error._tag).toBe("ThreadForkUnsupportedProviderError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("refuses when the binding routes through another instance", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread(),
        binding: { ...CODEX_BINDING, providerInstanceId: ProviderInstanceId.make("other") },
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error._tag).toBe("ThreadForkInstanceMismatchError");
    }),
  );

  it.effect("refuses while a turn is running", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({ latestTurn: { ...COMPLETED_TURN, state: "running" } }),
        binding: CODEX_BINDING,
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({
        _tag: "ThreadForkNotQuiescentError",
        reason: "turn",
      });
    }),
  );

  // Live clock: the queued-turn grace window compares the message against
  // `DateTime.now`, which TestClock would freeze in the far past.
  it.live("refuses while a user message waits for its turn", () =>
    Effect.gen(function* () {
      const fresh = DateTime.formatIso(yield* DateTime.now);
      const harness = yield* makeHarness({
        thread: makeThread({
          latestTurn: null,
          messages: [makeMessage("thread-1:000001", "user", "still typing", fresh)],
        }),
        binding: CODEX_BINDING,
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({ _tag: "ThreadForkNotQuiescentError", reason: "turn" });
    }),
  );

  it.effect("refuses while an approval request is open", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({
          activities: [makeActivity("approval.requested", { requestId: "req-1" })],
        }),
        binding: CODEX_BINDING,
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({ _tag: "ThreadForkNotQuiescentError", reason: "requests" });
    }),
  );

  it.effect("refuses a deleted thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({ deletedAt: "2026-08-21T00:00:00.000Z" }),
        binding: CODEX_BINDING,
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({ _tag: "ThreadForkSourceStateError", reason: "deleted" });
    }),
  );

  it.effect("refuses an archived thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({ archivedAt: "2026-08-21T00:00:00.000Z" }),
        binding: CODEX_BINDING,
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({ _tag: "ThreadForkSourceStateError", reason: "archived" });
    }),
  );

  it.effect("refuses a thread without a binding", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: makeThread(), binding: null });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({ _tag: "ThreadForkSourceStateError", reason: "no-cursor" });
    }),
  );

  it.effect("refuses a Claude binding whose cursor has no native session id", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({
          modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-sonnet" },
        }),
        binding: {
          ...CLAUDE_BINDING,
          resumeCursor: { resume: "not-a-uuid" } as unknown as typeof CLAUDE_BINDING.resumeCursor,
        },
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({ _tag: "ThreadForkSourceStateError", reason: "no-cursor" });
    }),
  );

  it.effect("refuses a Codex thread whose latest turn never completed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({ latestTurn: null }),
        binding: CODEX_BINDING,
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({ _tag: "ThreadForkSourceStateError", reason: "no-fork-point" });
    }),
  );

  it.effect("refuses a thread with nothing importable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread({ messages: [] }),
        binding: CODEX_BINDING,
      });
      const error = yield* Effect.flip(harness.fork());
      expect(error).toMatchObject({ _tag: "ThreadForkSourceStateError", reason: "no-history" });
      expect(yield* Ref.get(harness.upserts)).toEqual([]);
    }),
  );
});
