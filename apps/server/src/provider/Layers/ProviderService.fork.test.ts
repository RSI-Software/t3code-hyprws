// @effect-diagnostics nodeBuiltinImport:off
import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "@t3tools/contracts";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ProviderAdapterSessionNotFoundError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();
const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};
function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER) {
  const sessions = new Map<ThreadId, ProviderSession>();
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Fork sibling preserves the upstream file-local adapter harness unchanged.
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );
  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }
      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );
  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );
  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );
  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );
  const stopSession = vi.fn((threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.delete(threadId);
    }),
  );
  const listSessions = vi.fn((): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() => Array.from(sessions.values())),
  );
  const hasSession = vi.fn((threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(sessions.has(threadId)),
  );
  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{
          id: TurnId;
          items: readonly [];
        }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );
  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: readonly [];
      },
      ProviderAdapterError
    > => Effect.succeed({ threadId, turns: [] }),
  );
  const uploadFeedback = vi.fn(
    (
      input: ProviderUploadFeedbackInput,
    ): Effect.Effect<ProviderUploadFeedbackResult, ProviderAdapterError> =>
      Effect.succeed({ feedbackId: `feedback-${input.threadId}` }),
  );
  const stopAll = vi.fn((): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.clear();
    }),
  );
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      ...(provider === CODEX_DRIVER ? { promptlessTurnContinuation: true } : {}),
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    ...(provider === CODEX_DRIVER ? { uploadFeedback } : {}),
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };
  const emit = (event: LegacyProviderRuntimeEvent): void => {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Fork sibling preserves the upstream file-local adapter harness unchanged.
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };
  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };
  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    uploadFeedback,
    stopAll,
  };
}
function makeProviderServiceLayer(
  input: {
    readonly directory?: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  } = {},
) {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });
  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer =
    input.directory === undefined
      ? ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
      : Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, input.directory);
  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );
  return {
    codex,
    claude,
    cursor,
    layer,
  };
}
const routing = makeProviderServiceLayer();
routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("recovers stale sessions for sendTurn using the persisted project id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const projectId = ProjectId.make("project-send-turn");
      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        projectId,
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });
      const firstStartInput = routing.codex.startSession.mock.lastCall?.[0] as
        | {
            projectId?: string;
          }
        | undefined;
      assert.equal(firstStartInput?.projectId, projectId);
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0] as
        | {
            projectId?: string;
          }
        | undefined;
      assert.equal(resumedStartInput?.projectId, projectId);
    }),
  );
});
