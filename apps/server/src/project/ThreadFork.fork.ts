// Fork-only: the `thread.fork` handler — fork a thread from the thread menu,
// same provider (Claude and Codex only). Guards run against the projection
// read model and the provider session directory; the child is created through
// the import pipeline's own commands (`thread.create` +
// `thread.history.import`, which settles the child, followed by
// `thread.unsettle`) so no new orchestration command, event, or projector is
// needed. Native fork timing: Claude clones eagerly via the scoped history
// worker (`ClaudeHistoryCommand.fork.ts`); Codex installs a fork cursor and
// clones lazily at the child's first session start.
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  WS_METHODS,
  ThreadForkError,
  isImportedAgentSessionMessageId,
  type ThreadForkInput,
  type ThreadForkResult,
  type ProviderInstanceId,
  type EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";
import {
  forkClaudeSession,
  readClaudeForkSourceSessionId,
  resolveClaudeForkInstanceEnvironment,
} from "../provider/Layers/ClaudeThreadFork.fork.ts";
import {
  readCodexForkCutoffFork,
  readCodexForkSourceThreadId,
} from "../provider/Layers/CodexThreadFork.fork.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";

const FORKABLE_PROVIDERS: ReadonlyArray<ProviderDriverKind> = [
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
];

/** The instance the thread currently routes through. */
const threadInstanceId = (thread: OrchestrationThread): ProviderInstanceId | undefined =>
  thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;

// Mirrors the decider's private `openRequests` + `isStaleRequestFailureDetail`
// (decider.ts): the handlers are not exported upstream, so the fork keeps a
// local copy instead of widening the decider's surface.
const isStaleRequestFailureDetailFork = (payload: Record<string, unknown> | null): boolean => {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
};

/** Mirror of the decider's `openRequests`: pending approval/user-input asks. */
const openRequestsFork = (
  thread: Pick<OrchestrationThread, "activities">,
): ReadonlyMap<string, OrchestrationThreadActivity> => {
  const requests = new Map<string, OrchestrationThreadActivity>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      requests.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetailFork(payload)
    ) {
      requests.delete(requestId);
    }
  }
  return requests;
};

/** A queued turn start: a user message no turn has adopted yet. */
const hasQueuedTurnStartFork = (thread: OrchestrationThread, now: string): boolean => {
  let latestUserMessageAt: string | null = null;
  let latestUserMessageAtMs = Number.NEGATIVE_INFINITY;
  for (const message of thread.messages) {
    if (message.role !== "user" || isImportedAgentSessionMessageId(message.id)) continue;
    const messageAtMs = Date.parse(message.createdAt);
    latestUserMessageAtMs = Math.max(latestUserMessageAtMs, messageAtMs);
    if (messageAtMs === latestUserMessageAtMs) {
      latestUserMessageAt = message.createdAt;
    }
  }
  return threadHasQueuedTurnStart(
    {
      latestUserMessageAt,
      latestTurn: thread.latestTurn,
      session: thread.session,
    },
    now,
  );
};

/** User + assistant prose only; tool rows, activities, and plans stay behind. */
const forkableMessages = (thread: OrchestrationThread) =>
  thread.messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0,
  );

/** The Codex cutoff: the source's latest completed native turn id. */
const codexForkLastTurnId = (thread: OrchestrationThread): string | undefined =>
  thread.latestTurn !== null && thread.latestTurn.state === "completed"
    ? thread.latestTurn.turnId
    : undefined;

/** Forking an already-forked title must not stack the suffix. */
const forkTitle = (title: string): string => `${title.replace(/ \(fork\)$/, "")} (fork)`;

/** What quiescence looked like when the fork started; the race check compares. */
interface SourceQuiescenceSnapshot {
  readonly latestTurnId: string | null;
  readonly messageCount: number;
}

const quiescenceSnapshotOf = (thread: OrchestrationThread): SourceQuiescenceSnapshot => ({
  latestTurnId: thread.latestTurn?.turnId ?? null,
  messageCount: thread.messages.length,
});

/**
 * Re-read the source after any native side effect and refuse if it moved on:
 * a new turn, a running turn, or a fresh pending request means the clone (or
 * cursor cutoff) no longer matches what the user saw.
 */
const sourceRacedSinceFork = (
  thread: OrchestrationThread,
  before: SourceQuiescenceSnapshot,
): boolean =>
  (thread.latestTurn?.turnId ?? null) !== before.latestTurnId ||
  thread.messages.length !== before.messageCount ||
  thread.latestTurn?.state === "running" ||
  thread.session?.activeTurnId != null ||
  thread.session?.status === "running" ||
  thread.session?.status === "starting" ||
  openRequestsFork(thread).size > 0;

/** Install the child's cursor and thread, then unsettle what import settled. */
export const forkThreadSource = Effect.fn("forkThreadSource")(function* (input: ThreadForkInput) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const threadOption = yield* snapshots.getThreadDetailById(input.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadForkError({
          threadId: input.threadId,
          reason: "orchestration-failed",
          detail: String(cause),
        }),
    ),
  );
  if (Option.isNone(threadOption)) {
    return yield* new ThreadForkError({ threadId: input.threadId, reason: "source-missing" });
  }
  const thread = threadOption.value;
  const quiescenceBefore = quiescenceSnapshotOf(thread);

  if (thread.deletedAt !== null) {
    return yield* new ThreadForkError({ threadId: thread.id, reason: "source-deleted" });
  }
  if (thread.archivedAt !== null) {
    return yield* new ThreadForkError({ threadId: thread.id, reason: "source-archived" });
  }

  const nowIso = DateTime.formatIso(yield* DateTime.now);
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.activeTurnId != null ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    hasQueuedTurnStartFork(thread, nowIso)
  ) {
    return yield* new ThreadForkError({ threadId: thread.id, reason: "turn-running" });
  }
  if (openRequestsFork(thread).size > 0) {
    return yield* new ThreadForkError({ threadId: thread.id, reason: "pending-requests" });
  }

  const instanceId = threadInstanceId(thread);
  const bindingOption = yield* directory.getBinding(thread.id).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadForkError({
          threadId: thread.id,
          reason: "orchestration-failed",
          detail: String(cause),
        }),
    ),
  );
  if (instanceId === undefined || Option.isNone(bindingOption)) {
    return yield* new ThreadForkError({ threadId: thread.id, reason: "no-cursor" });
  }
  const binding = bindingOption.value;
  if (binding.providerInstanceId !== undefined && binding.providerInstanceId !== instanceId) {
    return yield* new ThreadForkError({ threadId: thread.id, reason: "instance-mismatch" });
  }
  // The child copies `modelSelection`; a session bound to another instance
  // would fork a conversation the child cannot route to.
  if (thread.modelSelection.instanceId !== instanceId) {
    return yield* new ThreadForkError({ threadId: thread.id, reason: "instance-mismatch" });
  }
  if (!(FORKABLE_PROVIDERS as ReadonlyArray<string>).includes(binding.provider)) {
    return yield* new ThreadForkError({
      threadId: thread.id,
      reason: "unsupported-provider",
      provider: binding.provider,
    });
  }

  const nextCommandId = () =>
    crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ThreadForkError({
            threadId: thread.id,
            reason: "orchestration-failed",
            detail: String(cause),
          }),
      ),
      Effect.map(CommandId.make),
    );

  const childThreadId = ThreadId.make(`import:${instanceId}:fork-${yield* nextCommandId()}`);

  // The child shares the source's checkout; the binding's cwd follows the
  // same runtimePayload → worktree → project-root precedence the importer uses.
  const projectOption = yield* snapshots.getProjectShellById(thread.projectId).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadForkError({
          threadId: thread.id,
          reason: "orchestration-failed",
          detail: String(cause),
        }),
    ),
  );
  const cwd =
    (typeof binding.runtimePayload === "object" &&
    binding.runtimePayload !== null &&
    typeof (binding.runtimePayload as { readonly cwd?: unknown }).cwd === "string"
      ? (binding.runtimePayload as { readonly cwd: string }).cwd
      : thread.worktreePath) ??
    (Option.isSome(projectOption) ? projectOption.value.workspaceRoot : undefined) ??
    thread.worktreePath ??
    "";

  // Refuse before any native side effect: an empty history must not leave an
  // orphan clone (Claude forks eagerly below).
  const messages = forkableMessages(thread);
  if (messages.length === 0) {
    return yield* new ThreadForkError({ threadId: thread.id, reason: "no-history" });
  }

  let childCursor: unknown;
  if (binding.provider === "claudeAgent") {
    const sourceSessionId = readClaudeForkSourceSessionId(binding.resumeCursor);
    if (sourceSessionId === undefined) {
      return yield* new ThreadForkError({ threadId: thread.id, reason: "no-cursor" });
    }
    const environment = yield* resolveClaudeForkInstanceEnvironment(thread.id, instanceId);
    childCursor = yield* forkClaudeSession({
      threadId: childThreadId,
      sourceSessionId,
      cwd,
      environment,
    });
  } else {
    const source = readCodexForkSourceThreadId(binding.resumeCursor);
    // A fresh lazy fork has no completed turn of its own; reusing the cutoff
    // its own cursor already carries forks the same native history again.
    const lastTurnId = codexForkLastTurnId(thread) ?? readCodexForkCutoffFork(binding.resumeCursor);
    if (source === undefined || lastTurnId === undefined) {
      return yield* new ThreadForkError({
        threadId: thread.id,
        reason: source === undefined ? "no-cursor" : "no-fork-point",
      });
    }
    // Lazy fork: the child's first session start sends thread/fork from the
    // parent's native thread, cut at the turn captured at click time.
    childCursor = { threadId: source, forkFrom: { lastTurnId } };
  }

  // The source must not have moved on while the native fork ran; anything
  // dispatched past this point creates a child that would diverge silently.
  const threadAfterForkOption = yield* snapshots.getThreadDetailById(input.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadForkError({
          threadId: thread.id,
          reason: "orchestration-failed",
          childThreadId,
          detail: String(cause),
        }),
    ),
  );
  if (
    Option.isNone(threadAfterForkOption) ||
    sourceRacedSinceFork(threadAfterForkOption.value, quiescenceBefore)
  ) {
    return yield* new ThreadForkError({
      threadId: thread.id,
      reason: "source-race",
      childThreadId: Option.isSome(threadAfterForkOption) ? childThreadId : null,
    });
  }

  // Insert-ignore: a lost RPC response can retry the fork, and an existing
  // newer binding must win over this one.
  yield* directory
    .upsert(
      {
        threadId: childThreadId,
        provider: binding.provider,
        providerInstanceId: instanceId,
        status: "stopped",
        runtimeMode: thread.runtimeMode,
        resumeCursor: childCursor,
        runtimePayload: { cwd },
      },
      { onConflict: "ignore" },
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ThreadForkError({
            threadId: thread.id,
            reason: "orchestration-failed",
            childThreadId,
            detail: String(cause),
          }),
      ),
    );

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadForkError({
            threadId: thread.id,
            reason: "orchestration-failed",
            childThreadId,
            detail: String(cause),
          }),
      ),
    );

  yield* dispatch({
    type: "thread.create",
    commandId: yield* nextCommandId(),
    threadId: childThreadId,
    projectId: thread.projectId,
    title: forkTitle(thread.title),
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    createdAt: nowIso,
    historyImport: true,
  });

  yield* dispatch({
    type: "thread.history.import",
    commandId: yield* nextCommandId(),
    threadId: childThreadId,
    messages: messages.map((message, index) => ({
      messageId: MessageId.make(`${childThreadId}:${String(index).padStart(6, "0")}`),
      role: message.role === "user" ? ("user" as const) : ("assistant" as const),
      text: message.text,
      createdAt: message.createdAt,
    })),
  });

  // The import settles the child; a fork must surface as active work.
  yield* dispatch({
    type: "thread.unsettle",
    commandId: yield* nextCommandId(),
    threadId: childThreadId,
    reason: "user",
  });

  return { childThreadId } satisfies ThreadForkResult;
});

interface ThreadForkHandlerDeps {
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  readonly engine: OrchestrationEngine.OrchestrationEngineService["Service"];
  readonly crypto: Crypto.Crypto;
  readonly settings: ServerSettings.ServerSettingsService["Service"];
}

type ObserveRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

/**
 * Spread into the upstream WS RPC handler table through the marked hook
 * `thread-fork/ws-rpc-handlers` in `ws.ts`. Ws-scope service instances are
 * provided explicitly, mirroring `agentSessionsImport`; the remaining
 * requirements (spawner, path, host kind) ride the ambient server context.
 */
export const threadForkRpcHandlersFork = (
  deps: ThreadForkHandlerDeps,
  observeRpcEffect: ObserveRpcEffect,
) => ({
  [WS_METHODS.threadFork]: (input: ThreadForkInput) =>
    observeRpcEffect(
      WS_METHODS.threadFork,
      forkThreadSource(input).pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, deps.snapshots),
        Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, deps.directory),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, deps.engine),
        Effect.provideService(Crypto.Crypto, deps.crypto),
        Effect.provideService(ServerSettings.ServerSettingsService, deps.settings),
      ),
      { "rpc.aggregate": "workspace" },
    ),
});
