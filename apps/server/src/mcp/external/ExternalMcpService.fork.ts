// Fork-owned service behind `/api/mcp/external`: thread coordination for an
// owner-approved client outside T3 (RSI-Software/t3code-hyprws device-auth
// domain). Upstream's `OrchestratorMcpService` answers to a calling provider
// thread; this answers to a device-authorized session and its grant policy,
// reusing upstream's projection helpers through the marked
// `device-auth/mcp-external-helpers` export.
import {
  type AuthSessionId,
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  OrchestratorMcpFailure,
  OrchestratorMcpCreatedThread,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpTarget,
  OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadWaitResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  externalMcpPolicyAllowsProject,
  type ExternalMcpPolicy,
} from "../../auth/ExternalMcpGrant.fork.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  listItemFromShellFork,
  resolveInteractionMode,
  resolveRuntimeMode,
  threadDetailFork,
  threadManagementFailureFork,
  threadRunFork,
  timelineItemFork,
} from "../OrchestratorMcpService.ts";
import {
  makeExternalMcpRequestLedger,
  requestFingerprint,
} from "./ExternalMcpRequestLedger.fork.ts";

const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;
// An external client holds an HTTP request open while it waits, so the budget
// stays well under common proxy and client timeouts.
const DEFAULT_WAIT_TIMEOUT_MS = 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
// An interrupt pin recording that no run was active; no run id is empty.
const NO_ACTIVE_RUN_PIN = "";

/** The authenticated external client one `/api/mcp/external` request acts for. */
export interface ExternalMcpPrincipal {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly clientLabel: string | null;
  readonly expiresAt: DateTime.DateTime | null;
  readonly policy: ExternalMcpPolicy;
}

export class ExternalMcpPrincipalFork extends Context.Service<
  ExternalMcpPrincipalFork,
  ExternalMcpPrincipal
>()("t3/mcp/external/ExternalMcpService.fork/ExternalMcpPrincipalFork") {}

export interface ExternalMcpProject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ExternalMcpThreadListResult {
  readonly projectId: ProjectId;
  readonly threads: ReadonlyArray<OrchestratorMcpThreadListItem>;
  readonly nextCursor: number | null;
  readonly total: number;
}

export interface ExternalMcpServiceShape {
  readonly listProjects: (
    principal: ExternalMcpPrincipal,
  ) => Effect.Effect<ReadonlyArray<ExternalMcpProject>, OrchestratorMcpFailure>;
  readonly listThreads: (
    principal: ExternalMcpPrincipal,
    input: OrchestratorMcpThreadListInput & { readonly projectId: ProjectId },
  ) => Effect.Effect<ExternalMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    principal: ExternalMcpPrincipal,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    principal: ExternalMcpPrincipal,
    input: {
      readonly threadId: ThreadId;
      readonly runId?: RunId | undefined;
      readonly timeoutMs?: number | undefined;
    },
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly createThread: (
    principal: ExternalMcpPrincipal,
    input: {
      readonly projectId: ProjectId;
      readonly clientRequestId: string;
      readonly title?: string | undefined;
      readonly prompt?: string | undefined;
      readonly target?: OrchestratorMcpTarget | undefined;
      readonly runtimeMode?: OrchestratorMcpRuntimeMode | undefined;
      readonly interactionMode?: OrchestratorMcpInteractionMode | undefined;
    },
  ) => Effect.Effect<OrchestratorMcpCreatedThread, OrchestratorMcpFailure>;
  readonly sendToThread: (
    principal: ExternalMcpPrincipal,
    input: {
      readonly threadId: ThreadId;
      readonly message: string;
      readonly mode?: "auto" | "queue" | "steer" | "restart" | undefined;
      readonly clientRequestId: string;
    },
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    principal: ExternalMcpPrincipal,
    input: {
      readonly threadId: ThreadId;
      readonly runId?: RunId | undefined;
      readonly reason?: string | undefined;
      readonly clientRequestId: string;
    },
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
}

export class ExternalMcpServiceFork extends Context.Service<
  ExternalMcpServiceFork,
  ExternalMcpServiceShape
>()("t3/mcp/external/ExternalMcpService.fork/ExternalMcpServiceFork") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Ids derived from the session and the client's request key. The request
 * ledger replays a finished request; these ids make an unfinished one replay
 * its command receipts. Another session's key never collides.
 */
const stableId = (principal: ExternalMcpPrincipal, operation: string, key: string) =>
  ["mcp-external", principal.sessionId, operation, key].map(encodeURIComponent).join(":");

const projectUnavailable = (projectId: ProjectId) =>
  failure("invalid_request", `Project ${projectId} is not available to this credential.`);

const threadUnavailable = (threadId: ThreadId) =>
  failure("thread_not_found", `Thread ${threadId} was not found.`);

const requireCoordinate = (principal: ExternalMcpPrincipal) =>
  principal.policy.coordinate
    ? Effect.void
    : Effect.fail(
        failure(
          "capability_denied",
          "This credential reads threads only; the environment owner grants coordination.",
        ),
      );

/** Refuses a thread whose modes exceed the grant's ceilings, in either direction of use. */
const requireWithinCeiling = (
  principal: ExternalMcpPrincipal,
  modes: {
    readonly runtimeMode: OrchestratorMcpRuntimeMode | undefined;
    readonly interactionMode: OrchestratorMcpInteractionMode | undefined;
  },
) =>
  Effect.all({
    runtimeMode: resolveRuntimeMode(principal.policy.maxRuntimeMode, modes.runtimeMode).pipe(
      Effect.mapError((error) =>
        failure(
          error.code,
          `Runtime mode ${modes.runtimeMode} exceeds this credential's ceiling ${principal.policy.maxRuntimeMode}.`,
        ),
      ),
    ),
    interactionMode: resolveInteractionMode(
      principal.policy.maxInteractionMode,
      modes.interactionMode,
    ).pipe(
      Effect.mapError((error) =>
        failure(
          error.code,
          `Interaction mode ${modes.interactionMode} exceeds this credential's ceiling ${principal.policy.maxInteractionMode}.`,
        ),
      ),
    ),
  });

/** Whether the grant caps either mode below the owner's own. */
const isCapped = (principal: ExternalMcpPrincipal) =>
  principal.policy.maxRuntimeMode !== "full-access" ||
  principal.policy.maxInteractionMode !== "default";

/**
 * Holds a thread to the grant's ceilings before a message reaches it. A capped
 * grant also gets the vetted modes, which its `message.dispatch` carries so the
 * orchestrator refuses it under the thread lock once the owner changed them.
 */
const vetThreadModes = (
  principal: ExternalMcpPrincipal,
  thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">,
) =>
  requireWithinCeiling(principal, thread).pipe(
    Effect.as(
      isCapped(principal)
        ? { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode }
        : undefined,
    ),
  );

/** How a delivered message reached its run, read the way `sendToThread` reports it. */
const deliveryOf = (
  turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> | null,
  mode: "auto" | "queue" | "steer" | "restart",
): OrchestratorMcpThreadSendResult["delivery"] =>
  turnItem === null || turnItem.inputIntent === "queued_turn"
    ? "queued"
    : turnItem.inputIntent === "turn_start"
      ? "started"
      : mode === "restart"
        ? "restarted"
        : "steered";

const make = Effect.gen(function* () {
  const events = yield* EventStore.EventStoreV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const ledger = yield* makeExternalMcpRequestLedger;

  const loadProject = (principal: ExternalMcpPrincipal, projectId: ProjectId) =>
    Effect.gen(function* () {
      if (!externalMcpPolicyAllowsProject(principal.policy, projectId)) {
        return yield* projectUnavailable(projectId);
      }
      const shell = yield* projects
        .getShell(projectId)
        .pipe(Effect.mapError((error) => failure("orchestration_error", errorMessage(error))));
      if (Option.isNone(shell)) return yield* projectUnavailable(projectId);
      return shell.value;
    });

  /** A thread outside the grant reads as missing, so its existence does not leak. */
  const loadThread = (principal: ExternalMcpPrincipal, threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.mapError((error) => failure("orchestration_error", errorMessage(error))));
      if (shell === null || !externalMcpPolicyAllowsProject(principal.policy, shell.projectId)) {
        return yield* threadUnavailable(threadId);
      }
      const target = yield* threadManagement
        .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [
          "runs",
          "runtimeRequests",
          "contextTransfers",
        ])
        .pipe(Effect.mapError(threadManagementFailureFork));
      if (target.thread.deletedAt !== null) return yield* threadUnavailable(threadId);
      return target;
    });

  /**
   * The message an earlier attempt already dispatched under its stable id, with
   * the run it reached, so a retry reports that run instead of acting again.
   */
  const dispatchedMessage = (projectId: ProjectId, threadId: ThreadId, messageId: MessageId) =>
    threadManagement
      .getProjectThreadRecords({ projectId, threadId }, ["runs", "messages", "turnItems"], {
        messageIds: [messageId],
        turnItemTypes: ["user_message"],
      })
      .pipe(
        Effect.mapError(threadManagementFailureFork),
        Effect.map((records) => {
          const runId = records.messages.find((message) => message.id === messageId)?.runId;
          const run = records.runs.find((candidate) => candidate.id === runId);
          if (run === undefined) return null;
          const turnItem =
            records.turnItems.find(
              (item): item is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
                item.type === "user_message" && item.messageId === messageId,
            ) ?? null;
          return { run, turnItem };
        }),
      );

  /**
   * A provider turn keeps the modes it started with, so after the owner
   * changes a thread's modes its running turn may sit above what the thread
   * now shows. True when a mode changed since `run` was requested.
   */
  const modesChangedSince = (threadId: ThreadId, run: OrchestrationV2Run) =>
    Effect.forEach(
      ["thread.runtime-mode-updated", "thread.interaction-mode-updated"] as const,
      (eventType) =>
        events.read({ threadId, eventType }).pipe(
          Stream.filter(
            (stored) =>
              DateTime.toEpochMillis(stored.event.occurredAt) >=
              DateTime.toEpochMillis(run.requestedAt),
          ),
          Stream.runHead,
          Effect.map(Option.isSome),
        ),
    ).pipe(
      Effect.map((changed) => changed.some(Boolean)),
      Effect.mapError((error) => failure("orchestration_error", errorMessage(error))),
    );

  const audit = (principal: ExternalMcpPrincipal, operation: string, detail: object) =>
    Effect.logInfo("external MCP mutation", {
      operation,
      sessionId: principal.sessionId,
      subject: principal.subject,
      clientLabel: principal.clientLabel,
      ...detail,
    });

  const resolveModelSelection = (
    project: OrchestrationProjectShell,
    target: OrchestratorMcpTarget | undefined,
  ): Effect.Effect<ModelSelection, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      if (target?.options !== undefined) {
        return yield* failure(
          "invalid_request",
          "Model options are not supported for external clients; use the project's default.",
        );
      }
      const providers = yield* providerRegistry.getProviders;
      const capable = new Set(yield* providerAdapters.list());
      const usable = providers.filter(
        (provider) =>
          capable.has(provider.instanceId) &&
          provider.enabled &&
          provider.installed &&
          isProviderAvailable(provider) &&
          provider.auth.status !== "unauthenticated",
      );
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((error) => failure("orchestration_error", errorMessage(error))),
      );
      // Like the composer, a default whose instance cannot run falls back to a usable one.
      const scopedDefault = resolveProjectSettings(settings, project.id, project).settings
        .defaultModelSelection;
      const projectDefault =
        scopedDefault !== null &&
        usable.some((provider) => provider.instanceId === scopedDefault.instanceId)
          ? scopedDefault
          : null;
      const instanceId =
        target?.providerInstanceId ??
        (target?.driverKind === undefined
          ? (projectDefault?.instanceId ?? usable[0]?.instanceId)
          : usable.find((provider) => provider.driver === target.driverKind)?.instanceId);
      const provider = usable.find((candidate) => candidate.instanceId === instanceId);
      if (instanceId === undefined || provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          instanceId === undefined
            ? "No available provider instance can run a thread."
            : `Provider instance ${instanceId} is not available.`,
        );
      }
      if (target?.driverKind !== undefined && provider.driver !== target.driverKind) {
        return yield* failure(
          "invalid_request",
          `Provider instance ${instanceId} uses driver ${provider.driver}, not ${target.driverKind}.`,
        );
      }
      if (
        target?.model === undefined &&
        projectDefault !== null &&
        projectDefault.instanceId === instanceId
      ) {
        return projectDefault;
      }
      const model = target?.model ?? provider.models[0]?.slug;
      if (model === undefined) {
        return yield* failure("model_unavailable", `Provider ${instanceId} advertises no model.`);
      }
      if (provider.models.length > 0 && !provider.models.some((m) => m.slug === model)) {
        return yield* failure(
          "model_unavailable",
          `Model ${model} is not advertised by provider ${instanceId}.`,
        );
      }
      return { instanceId, model };
    });

  return ExternalMcpServiceFork.of({
    listProjects: (principal) =>
      projects
        .listShells(
          principal.policy.projectIds === "*"
            ? undefined
            : { projectIds: principal.policy.projectIds },
        )
        .pipe(
          Effect.map((shells) =>
            shells
              .filter((shell) => externalMcpPolicyAllowsProject(principal.policy, shell.id))
              .map((shell) => ({
                projectId: shell.id,
                title: shell.title,
                workspaceRoot: shell.workspaceRoot,
              })),
          ),
          Effect.mapError((error) => failure("orchestration_error", errorMessage(error))),
        ),

    listThreads: (principal, input) =>
      Effect.gen(function* () {
        yield* loadProject(principal, input.projectId);
        const projectThreads = yield* threadManagement
          .listProjectThreads({
            projectId: input.projectId,
            includeSubagents: input.includeSubagents !== false,
          })
          .pipe(Effect.mapError(threadManagementFailureFork));
        const statuses = input.statuses === undefined ? null : new Set(input.statuses);
        const titleContains = input.titleContains?.toLocaleLowerCase();
        const filtered = projectThreads
          .map(listItemFromShellFork)
          .filter((thread) => statuses === null || statuses.has(thread.status))
          .filter((thread) => input.settled === undefined || thread.settled === input.settled)
          .filter(
            (thread) =>
              titleContains === undefined ||
              thread.title.toLocaleLowerCase().includes(titleContains),
          );
        const cursor = input.cursor ?? 0;
        const page = filtered.slice(cursor, cursor + (input.limit ?? DEFAULT_THREAD_LIST_LIMIT));
        return {
          projectId: input.projectId,
          threads: page,
          nextCursor: cursor + page.length < filtered.length ? cursor + page.length : null,
          total: filtered.length,
        };
      }),

    readThread: (principal, input) =>
      Effect.gen(function* () {
        const target = yield* loadThread(principal, input.threadId);
        const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
        const timeline = yield* threadManagement
          .getTimelinePage(input.threadId, {
            afterPosition: input.afterPosition ?? -1,
            limit: input.limit ?? DEFAULT_THREAD_READ_LIMIT,
            view: input.view ?? "messages",
            ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
          })
          .pipe(Effect.mapError(threadManagementFailureFork));
        const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
        for (const row of timeline.items) {
          if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
          const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
          ids.push(row.item.messageId);
          messageIdsByThread.set(row.sourceThreadId, ids);
        }
        const messagesByThreadId = new Map(
          yield* Effect.forEach(
            [...messageIdsByThread],
            ([threadId, messageIds]) =>
              threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
                Effect.map((records) => [threadId, records.messages] as const),
                Effect.mapError(threadManagementFailureFork),
              ),
            { concurrency: 1 },
          ),
        );
        return {
          thread: threadDetailFork(target, timeline.totalItems),
          recentRuns: target.runs
            .toSorted((left, right) => right.ordinal - left.ordinal)
            .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
            .map(threadRunFork),
          items: timeline.items.map((row) =>
            timelineItemFork({
              row,
              maxChars,
              messagesByThreadId,
              ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
            }),
          ),
          nextPosition: timeline.items.at(-1)?.position ?? null,
          hasMore: timeline.hasMore,
        } satisfies OrchestratorMcpThreadReadResult;
      }),

    waitForThread: (principal, input) =>
      Effect.gen(function* () {
        const target = yield* loadThread(principal, input.threadId);
        const result = yield* threadManagement
          .waitForThread({
            projectId: target.thread.projectId,
            threadId: input.threadId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            timeoutMs: Math.min(
              MAX_WAIT_TIMEOUT_MS,
              Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
            ),
          })
          .pipe(Effect.mapError(threadManagementFailureFork));
        return {
          threadId: input.threadId,
          runId: result.run?.id ?? null,
          status: result.run?.status ?? "idle",
          timedOut: result.timedOut,
        } satisfies OrchestratorMcpThreadWaitResult;
      }),

    createThread: (principal, input) =>
      Effect.gen(function* () {
        yield* requireCoordinate(principal);
        const fingerprint = requestFingerprint([
          ["projectId", input.projectId],
          ["title", input.title],
          ["prompt", input.prompt],
          ["target", input.target],
          ["runtimeMode", input.runtimeMode],
          ["interactionMode", input.interactionMode],
        ]);
        return yield* ledger.run(
          {
            sessionId: principal.sessionId,
            operation: "create",
            clientRequestId: input.clientRequestId,
            fingerprint,
            result: OrchestratorMcpCreatedThread,
          },
          () =>
            Effect.gen(function* () {
              const project = yield* loadProject(principal, input.projectId);
              const modes = yield* requireWithinCeiling(principal, {
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
              });
              const modelSelection = yield* resolveModelSelection(project, input.target);
              const key = input.clientRequestId;
              const threadId = ThreadId.make(`thread:${stableId(principal, "create", key)}`);
              const detail = input.title?.trim() || input.prompt?.trim() || "External MCP thread";
              yield* audit(principal, "thread.create", { projectId: input.projectId, threadId });
              yield* threadManagement
                .dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId: CommandId.make(`command:${stableId(principal, "create", key)}`),
                  threadId,
                  projectId: input.projectId,
                  title: detail.length > 80 ? `${detail.slice(0, 77)}...` : detail,
                  modelSelection,
                  runtimeMode: modes.runtimeMode,
                  interactionMode: modes.interactionMode,
                  branch: null,
                  worktreePath: null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread: ${errorMessage(error)}`,
                    ),
                  ),
                );
              // An earlier attempt may have created the thread, or also sent its
              // prompt, and the owner may have changed it since: a sent prompt
              // is reported, and an unsent one goes only to a thread that still
              // sits in this project and under the grant's ceilings when the
              // prompt commits.
              const actual = yield* loadThread(principal, threadId);
              if (actual.thread.projectId !== input.projectId) {
                return yield* threadUnavailable(threadId);
              }
              const promptId = MessageId.make(`message:${stableId(principal, "create", key)}`);
              const sent =
                input.prompt === undefined
                  ? null
                  : yield* dispatchedMessage(input.projectId, threadId, promptId);
              if (input.prompt !== undefined && sent === null) {
                const expectedModes = yield* vetThreadModes(principal, actual.thread);
                yield* threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: CommandId.make(
                      `command:${stableId(principal, "create-dispatch", key)}`,
                    ),
                    threadId,
                    messageId: promptId,
                    text: input.prompt,
                    attachments: [],
                    modelSelection,
                    dispatchMode: { type: "start_immediately" },
                    ...(expectedModes === undefined ? {} : { expectedModes }),
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      failure(
                        "orchestration_error",
                        `Unable to start thread: ${errorMessage(error)}`,
                      ),
                    ),
                  );
              }
              const created = yield* loadThread(principal, threadId);
              const run =
                input.prompt === undefined
                  ? undefined
                  : ((yield* dispatchedMessage(input.projectId, threadId, promptId))?.run ??
                    undefined);
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: created.thread.title,
                createdBy: created.thread.createdBy,
                creationSource: created.thread.creationSource,
                providerInstanceId: created.thread.modelSelection.instanceId,
                model: created.thread.modelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
        );
      }),

    sendToThread: (principal, input) =>
      Effect.gen(function* () {
        yield* requireCoordinate(principal);
        const mode = input.mode ?? "auto";
        const fingerprint = requestFingerprint([
          ["threadId", input.threadId],
          ["message", input.message],
          ["mode", mode],
        ]);
        return yield* ledger.run(
          {
            sessionId: principal.sessionId,
            operation: "send",
            clientRequestId: input.clientRequestId,
            fingerprint,
            result: OrchestratorMcpThreadSendResult,
          },
          () =>
            Effect.gen(function* () {
              const target = yield* loadThread(principal, input.threadId);
              const messageId = MessageId.make(
                `message:${stableId(principal, "send", input.clientRequestId)}`,
              );
              // An earlier attempt that delivered the message is reported as it
              // landed, whatever the thread has done since.
              const sent = yield* dispatchedMessage(
                target.thread.projectId,
                input.threadId,
                messageId,
              );
              if (sent !== null) {
                return {
                  threadId: input.threadId,
                  messageId,
                  runId: sent.run.id,
                  status: sent.run.status,
                  delivery: deliveryOf(sent.turnItem, mode),
                } satisfies OrchestratorMcpThreadSendResult;
              }
              const expectedModes = yield* vetThreadModes(principal, target.thread);
              // Steering joins a running turn, so a capped credential is held to
              // turns requested under the thread's current modes; `auto` queues
              // instead. The send may join only the attempt vetted here, whose
              // modes its running provider turn fixed. Dispatch refuses the send
              // under the thread lock once the run moves to another attempt or
              // the modes vetted above change before it commits. Modes the owner
              // sets after that govern later turns, as for any queued message.
              const capped = isCapped(principal);
              let delivery = mode;
              let steerTarget: RunAttemptId | null | undefined;
              if (capped && (mode === "steer" || mode === "auto")) {
                const run = ThreadManagementService.latestActiveRun(target);
                const { providerTurns } = yield* threadManagement
                  .getProjectThreadRecords(
                    { projectId: target.thread.projectId, threadId: input.threadId },
                    ["providerTurns"],
                  )
                  .pipe(Effect.mapError(threadManagementFailureFork));
                steerTarget =
                  run?.activeAttemptId != null &&
                  providerTurns.some(
                    (turn) =>
                      turn.runAttemptId === run.activeAttemptId && turn.status === "running",
                  )
                    ? run.activeAttemptId
                    : null;
                if (run !== undefined && (yield* modesChangedSince(input.threadId, run))) {
                  if (mode === "steer") {
                    return yield* failure(
                      "runtime_mode_escalation_denied",
                      `Run ${run.id} started before this thread's modes changed, so this credential cannot steer it; send with mode queue.`,
                    );
                  }
                  delivery = "queue";
                }
              }
              yield* audit(principal, "thread.send", { threadId: input.threadId, messageId });
              const result = yield* threadManagement
                .sendToThread({
                  projectId: target.thread.projectId,
                  commandId: CommandId.make(
                    `command:${stableId(principal, "send", input.clientRequestId)}`,
                  ),
                  threadId: input.threadId,
                  messageId,
                  text: input.message,
                  attachments: [],
                  mode: delivery,
                  ...(steerTarget === undefined ? {} : { steerTarget }),
                  ...(expectedModes === undefined ? {} : { expectedModes }),
                  createdBy: "agent",
                  creationSource: "mcp",
                })
                .pipe(Effect.mapError(threadManagementFailureFork));
              return {
                threadId: input.threadId,
                messageId,
                runId: result.run.id,
                status: result.run.status,
                delivery: result.delivery,
              } satisfies OrchestratorMcpThreadSendResult;
            }),
        );
      }),

    interruptThread: (principal, input) =>
      Effect.gen(function* () {
        yield* requireCoordinate(principal);
        const fingerprint = requestFingerprint([
          ["threadId", input.threadId],
          ["runId", input.runId],
          ["reason", input.reason],
        ]);
        return yield* ledger.run(
          {
            sessionId: principal.sessionId,
            operation: "interrupt",
            clientRequestId: input.clientRequestId,
            fingerprint,
            result: OrchestratorMcpThreadInterruptResult,
          },
          (pin) =>
            Effect.gen(function* () {
              const target = yield* loadThread(principal, input.threadId);
              // The run an earlier attempt committed to, or its finding that
              // none was active, stays the answer, so a retry never reaches a
              // run that started after it.
              let runId =
                pin.recorded === null || pin.recorded === NO_ACTIVE_RUN_PIN
                  ? input.runId
                  : RunId.make(pin.recorded);
              if (pin.recorded === null) {
                yield* requireWithinCeiling(principal, target.thread);
                runId ??= ThreadManagementService.latestActiveRun(target)?.id;
                yield* pin.record(runId ?? NO_ACTIVE_RUN_PIN);
              }
              yield* audit(principal, "thread.interrupt", {
                threadId: input.threadId,
                runId: runId ?? null,
              });
              if (runId === undefined) {
                return { threadId: input.threadId, runId: null, status: "no_active_run" } as const;
              }
              const result = yield* threadManagement
                .interruptThread({
                  projectId: target.thread.projectId,
                  commandId: CommandId.make(
                    `command:${stableId(principal, "interrupt", input.clientRequestId)}`,
                  ),
                  threadId: input.threadId,
                  runId,
                  ...(input.reason === undefined ? {} : { reason: input.reason }),
                })
                .pipe(Effect.mapError(threadManagementFailureFork));
              if (result.type === "no_active_run") {
                return { threadId: input.threadId, runId: null, status: "no_active_run" } as const;
              }
              return {
                threadId: input.threadId,
                runId: result.run.id,
                status:
                  result.type === "already_terminal" ? result.run.status : "interrupt_requested",
              } satisfies OrchestratorMcpThreadInterruptResult;
            }),
        );
      }),
  });
});

export const layer = Layer.effect(ExternalMcpServiceFork, make).pipe(
  Layer.provide(EventStore.layer),
);
