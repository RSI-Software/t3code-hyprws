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
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpTarget,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadWaitResult,
  type ProjectId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  externalMcpPolicyAllowsProject,
  type ExternalMcpPolicy,
} from "../../auth/ExternalMcpGrant.fork.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import {
  listItemFromShellFork,
  resolveInteractionMode,
  resolveRuntimeMode,
  threadDetailFork,
  threadManagementFailureFork,
  threadRunFork,
  timelineItemFork,
} from "../OrchestratorMcpService.ts";

const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;
// An external client holds an HTTP request open while it waits, so the budget
// stays well under common proxy and client timeouts.
const DEFAULT_WAIT_TIMEOUT_MS = 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;

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
 * Ids derived from the session and the client's request key, so a retried
 * mutation replays its command receipt instead of acting twice. Another
 * session's key never collides.
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

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

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
      const projectDefault = project.defaultModelSelection;
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
              failure("orchestration_error", `Unable to create thread: ${errorMessage(error)}`),
            ),
          );
        if (input.prompt !== undefined) {
          yield* threadManagement
            .dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make(`command:${stableId(principal, "create-dispatch", key)}`),
              threadId,
              messageId: MessageId.make(`message:${stableId(principal, "create", key)}`),
              text: input.prompt,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            })
            .pipe(
              Effect.mapError((error) =>
                failure("orchestration_error", `Unable to start thread: ${errorMessage(error)}`),
              ),
            );
        }
        const created = yield* loadThread(principal, threadId);
        const run = created.runs.at(-1);
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

    sendToThread: (principal, input) =>
      Effect.gen(function* () {
        yield* requireCoordinate(principal);
        const target = yield* loadThread(principal, input.threadId);
        yield* requireWithinCeiling(principal, target.thread);
        const messageId = MessageId.make(
          `message:${stableId(principal, "send", input.clientRequestId)}`,
        );
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
            mode: input.mode ?? "auto",
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

    interruptThread: (principal, input) =>
      Effect.gen(function* () {
        yield* requireCoordinate(principal);
        const target = yield* loadThread(principal, input.threadId);
        yield* audit(principal, "thread.interrupt", { threadId: input.threadId });
        const result = yield* threadManagement
          .interruptThread({
            projectId: target.thread.projectId,
            commandId: CommandId.make(
              `command:${stableId(principal, "interrupt", input.clientRequestId)}`,
            ),
            threadId: input.threadId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(Effect.mapError(threadManagementFailureFork));
        if (result.type === "no_active_run") {
          return { threadId: input.threadId, runId: null, status: "no_active_run" } as const;
        }
        return {
          threadId: input.threadId,
          runId: result.run.id,
          status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }),
  });
});

export const layer = Layer.effect(ExternalMcpServiceFork, make);
