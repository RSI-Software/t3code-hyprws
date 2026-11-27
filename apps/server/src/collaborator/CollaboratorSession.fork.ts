// Fork-only (colleague-collab): adapts one session's RPC handlers to the threads shared with it.
// A collaborator session reaches a closed RPC set and a closed command set, attributed to them;
// the host's messages name the host to the agent. Share state stays in `CollaboratorShares.fork.ts`.
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type CollaboratorMessageErrorFork,
  type CollaboratorMessageFork,
  type CollaboratorResolveMessageInputFork,
  type CollaboratorSetTypingInputFork,
  type CollaboratorSubmitMessageInputFork,
  type CollaboratorTypingStateFork,
  type CollaboratorTypistFork,
  CollaboratorUnshareErrorFork,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2SubscribeShellInput,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadStreamItem,
  type RunId,
  RpcScopeAuthorization,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { CollaboratorShare, CollaboratorSharesFork } from "./CollaboratorShares.fork.ts";
import {
  collaboratorAttribution,
  hostAttribution,
  makeCollaboratorMessages,
} from "./CollaboratorMessages.fork.ts";
import { makeCollaboratorTyping } from "./CollaboratorTyping.fork.ts";
import { collaboratorSubject, isCollaboratorSubject } from "./collaboratorSubject.fork.ts";

// Every host session types as one typist, so a host never sees their own other device.
const HOST_TYPIST: CollaboratorTypistFork = { subject: "host" };

type Shares = ReadonlyMap<string, CollaboratorShare>;
type Service = CollaboratorSharesFork["Service"];

/** Everyone a thread was ever shared with, in the order they joined, so each keeps a colour. */
const peopleOf = (shares: Shares, threadId: string) =>
  [...shares.values()]
    .flatMap(({ name, since }) => {
      const at = since.get(threadId);
      return at === undefined ? [] : [{ name, at }];
    })
    .sort((a, b) => a.at - b.at)
    .map(({ name }) => name);

const sameIds = (a: Iterable<string> = [], b: Iterable<string> = []) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
};

const sameShare = (a: CollaboratorShare | undefined, b: CollaboratorShare | undefined) =>
  sameIds(a?.threadIds.keys(), b?.threadIds.keys()) &&
  [...(a?.threadIds ?? [])].every(([id, access]) => b?.threadIds.get(id) === access) &&
  sameIds(a?.frozen.keys(), b?.frozen.keys());

const frozenShells = (share: CollaboratorShare | undefined) =>
  [...(share?.frozen.values() ?? [])].map((thread) => ({
    ...thread,
    collaboratorFork: "frozen" as const,
  }));

/** Narrows one shell item; an authoritative snapshot resets `projects` to the shared threads'. */
const filterShellItem = (
  share: CollaboratorShare | undefined,
  projects: Set<string>,
  item: OrchestrationV2ShellStreamItem,
): OrchestrationV2ShellStreamItem | undefined => {
  const hasThread = (id: string) => share?.threadIds.has(id) === true;
  // The collaborator's client reads its access from the thread itself.
  const withAccess = <T extends { readonly id: string }>(thread: T) => {
    const access = share?.threadIds.get(thread.id);
    return access === undefined ? thread : { ...thread, collaboratorFork: access };
  };
  switch (item.kind) {
    case "synchronized":
      return item;
    case "snapshot": {
      const { olderSettled: _olderSettled, ...snapshot } = item.snapshot;
      // An enrichment snapshot only refreshes project metadata and carries no threads.
      if (item.resolvedRepositoryIdentityRoots !== undefined) {
        return {
          ...item,
          snapshot: {
            ...snapshot,
            projects: snapshot.projects.filter((project) => projects.has(project.id)),
          },
        };
      }
      // A frozen copy stands in for the live thread, so it never reveals later changes.
      const frozen = frozenShells(share);
      const threads = [
        ...snapshot.threads.filter((thread) => hasThread(thread.id)).map(withAccess),
        ...frozen.filter((thread) => thread.archivedAt === null),
      ];
      const archivedThreads = [
        ...snapshot.archivedThreads.filter((thread) => hasThread(thread.id)).map(withAccess),
        ...frozen.filter((thread) => thread.archivedAt !== null),
      ];
      projects.clear();
      for (const thread of [...threads, ...archivedThreads]) projects.add(thread.projectId);
      return {
        ...item,
        snapshot: {
          ...snapshot,
          threads,
          archivedThreads,
          projects: snapshot.projects.filter((project) => projects.has(project.id)),
        },
      };
    }
    case "project.updated":
      return projects.has(item.project.id) ? item : undefined;
    case "project.removed":
      return projects.has(item.projectId) ? item : undefined;
    case "thread.updated":
      return hasThread(item.thread.id) ? { ...item, thread: withAccess(item.thread) } : undefined;
    case "thread.removed":
      return hasThread(item.threadId) ? item : undefined;
  }
};

const {
  dispatchCommand: DISPATCH,
  launchThread: LAUNCH,
  subscribeShell: SHELL,
  subscribeThread: THREAD,
} = ORCHESTRATION_V2_WS_METHODS;
const {
  collaboratorSubscribeMessagesFork: MESSAGES,
  collaboratorSubmitMessageFork: SUBMIT,
  collaboratorResolveMessageFork: RESOLVE,
  collaboratorSetTypingFork: SET_TYPING,
  collaboratorSubscribeTypingFork: TYPING,
} = WS_METHODS;

type MessageError = CollaboratorMessageErrorFork | EnvironmentAuthorizationError;

/** The waiting-message RPCs, answered per session: `null` is the host, who sees and sends all. */
export interface CollaboratorMessageHandlersFork {
  readonly [MESSAGES]: () => Stream.Stream<
    ReadonlyArray<CollaboratorMessageFork>,
    EnvironmentAuthorizationError
  >;
  readonly [SUBMIT]: (
    input: CollaboratorSubmitMessageInputFork,
  ) => Effect.Effect<void, MessageError>;
  readonly [RESOLVE]: (
    input: CollaboratorResolveMessageInputFork,
  ) => Effect.Effect<void, MessageError>;
}

/** The typing RPCs, answered per session: `null` is the host. */
export interface CollaboratorTypingHandlersFork {
  readonly [SET_TYPING]: (
    input: CollaboratorSetTypingInputFork,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  readonly [TYPING]: (input: {
    readonly threadId: string;
  }) => Stream.Stream<CollaboratorTypingStateFork, EnvironmentAuthorizationError>;
}

// `options: never` accepts each upstream handler whatever its RPC options type.
export interface CollaboratorHandlersFork<A, E, R, SE, SR, TE, TR, LA, LE, LR> {
  readonly [DISPATCH]: (command: OrchestrationV2Command, options: never) => Effect.Effect<A, E, R>;
  readonly [LAUNCH]: (
    input: OrchestrationV2ThreadLaunchInput,
    options: never,
  ) => Effect.Effect<LA, LE, LR>;
  readonly [SHELL]: (
    input: OrchestrationV2SubscribeShellInput,
    options: never,
  ) => Stream.Stream<OrchestrationV2ShellStreamItem, SE, SR>;
  readonly [THREAD]: (
    input: OrchestrationV2SubscribeThreadInput,
    options: never,
  ) => Stream.Stream<OrchestrationV2ThreadStreamItem, TE, TR>;
}

const itemSequence = (item: OrchestrationV2ThreadStreamItem) =>
  item.kind === "snapshot"
    ? item.snapshotSequence
    : item.kind === "synchronized"
      ? 0
      : item.sequence;

const commandThreadId = (command: OrchestrationV2Command) =>
  command.type === "thread.fork" || command.type === "thread.merge_back"
    ? command.targetThreadId
    : command.type === "delegated_task.request" ||
        command.type === "delegated_task.wake-policy" ||
        command.type === "delegated_task.completion-delivery.acknowledge" ||
        command.type === "delegated_task.completion-delivery.dispose" ||
        command.type === "thread.created.record"
      ? command.parentThreadId
      : command.threadId;

/** Names the collaborator in the text the agent reads; their own words ride the context. */
const attributed = <Command extends Extract<OrchestrationV2Command, { readonly text: string }>>(
  name: string,
  command: Command,
): Command => {
  const attribution = collaboratorAttribution(name, command.text);
  return {
    ...command,
    text: attribution.text,
    context: { version: 1, records: [], ...command.context, ...attribution.context },
  };
};

/** Only the server attributes a message to a collaborator; a client's claim is dropped. */
const withoutCollaboratorAttribution = (
  command: OrchestrationV2Command,
): OrchestrationV2Command => {
  if (
    (command.type !== "message.dispatch" && command.type !== "queued-run.edit") ||
    command.context?.collaboratorFork === undefined
  ) {
    return command;
  }
  const { collaboratorFork: _claimed, ...context } = command.context;
  return { ...command, context };
};

const launchWithoutAttribution = (
  input: OrchestrationV2ThreadLaunchInput,
): OrchestrationV2ThreadLaunchInput => {
  const context = input.initialMessage?.context;
  if (input.initialMessage === undefined || context?.collaboratorFork === undefined) return input;
  const { collaboratorFork: _claimed, ...rest } = context;
  return { ...input, initialMessage: { ...input.initialMessage, context: rest } };
};

const notShared = (
  requiredScope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  new EnvironmentAuthorizationError({
    message: "This thread is no longer shared with you.",
    requiredScope,
  });

const notCollaboratorRpc = new EnvironmentAuthorizationError({
  message: "A collaborator session reaches only the threads shared with it.",
  requiredScope: AuthOrchestrationReadScope,
});

const needsApproval = new EnvironmentAuthorizationError({
  message: "The host approves your messages before they run. Send them from the composer.",
  requiredScope: AuthOrchestrationOperateScope,
});

// A `send` collaborator takes part in the conversation; managing the thread, its queued
// messages, its runtime mode, and its checkpoints stays the host's. Their own queued messages
// are the exception: they may edit or remove them.
const COLLABORATOR_COMMANDS: ReadonlySet<OrchestrationV2Command["type"]> = new Set([
  "message.dispatch",
  "queue.resume",
  "prepared-run.retry",
  "run.interrupt",
  "thread.stop",
  "subagent.stop",
  "runtime-request.respond",
  "thread.user-input.dismiss",
  "thread.model-selection.set",
  "thread.interaction-mode.set",
  "thread.visit",
  "thread.mark-unread",
]);

const hostOnly = new EnvironmentAuthorizationError({
  message: "Only the host can change this thread.",
  requiredScope: AuthOrchestrationOperateScope,
});

const notCollaborator = new EnvironmentAuthorizationError({
  message: "Only a collaborator submits messages for approval.",
  requiredScope: AuthOrchestrationOperateScope,
});

// The closed set a collaborator session may call. `wrapHandlers` narrows the shell, thread, and
// dispatch handlers; every other listed RPC names one thread, which must be shared live.
const COLLABORATOR_OPEN_RPCS: ReadonlySet<string> = new Set([
  WS_METHODS.serverGetConfig,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.serverProbe,
  WS_METHODS.serverReportClientActivity,
  DISPATCH,
  SHELL,
  THREAD,
  MESSAGES,
  // Accepting an invite saves the host as a colleague; `ColleaguesFork.save` refuses non-sharers.
  WS_METHODS.colleagueSaveFork,
]);
const COLLABORATOR_THREAD_RPCS: ReadonlySet<string> = new Set([
  SUBMIT,
  RESOLVE,
  SET_TYPING,
  TYPING,
  ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_V2_WS_METHODS.getTurnItem,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  ORCHESTRATION_V2_WS_METHODS.searchThread,
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
]);

const payloadThreadId = (payload: unknown): string | undefined => {
  const threadId = Predicate.isObject(payload)
    ? (payload as { threadId?: unknown }).threadId
    : undefined;
  return typeof threadId === "string" ? threadId : undefined;
};

/** The thread an asset URL request reads, or `null` for an unguessable upload id. */
const assetThreadId = (payload: unknown): string | null | undefined => {
  const resource = Predicate.isObject(payload)
    ? (payload as { resource?: { _tag?: unknown; threadId?: unknown } }).resource
    : undefined;
  if (resource?._tag === "attachment") return null;
  return resource?._tag === "tool-output-image" && typeof resource.threadId === "string"
    ? resource.threadId
    : undefined;
};

export const makeCollaboratorSession = Effect.fn("makeCollaboratorSession")(function* (state: {
  /** The shares as they are now. */
  readonly current: () => Shares;
  /** The shares now and on every change. */
  readonly changes: Stream.Stream<Shares>;
  readonly isShared: (subject: string, threadId: string) => boolean;
}) {
  const { current, changes, isShared } = state;
  const messages = yield* makeCollaboratorMessages;
  const typing = yield* makeCollaboratorTyping;
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  // The host has no name here; the agent reads the one they gave git, else "the owner".
  const hostName = yield* Effect.cached(
    git
      .execute({
        operation: "CollaboratorSharesFork.hostName",
        cwd: config.cwd,
        args: ["config", "--get", "user.name"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim() || undefined),
        Effect.orElseSucceed(() => undefined),
      ),
  );

  const shell = <SE, SR>(
    subject: string,
    input: OrchestrationV2SubscribeShellInput,
    open: (
      input: OrchestrationV2SubscribeShellInput,
    ) => Stream.Stream<OrchestrationV2ShellStreamItem, SE, SR>,
  ) => {
    // Always a full, untrimmed snapshot: a resume could skip a thread shared since the last
    // connection, and the omissions could hide a shared thread.
    const {
      afterSequence: _resume,
      omitIdleSubagents: _idle,
      omitOlderSettled: _settled,
      ...fresh
    } = input;
    // A shared thread moving to a project the collaborator cannot see re-snapshots to bring it in.
    const narrowed = (
      collaboratorShare: CollaboratorShare | undefined,
    ): Stream.Stream<OrchestrationV2ShellStreamItem, SE, SR> =>
      Stream.suspend(() => {
        const projects = new Set<string>();
        let moved = false;
        return open(fresh).pipe(
          Stream.map((item) => filterShellItem(collaboratorShare, projects, item)),
          Stream.filter(Predicate.isNotUndefined),
          Stream.takeUntil(
            (item) =>
              (moved = item.kind === "thread.updated" && !projects.has(item.thread.projectId)),
            { excludeLast: true },
          ),
          Stream.concat(Stream.suspend(() => (moved ? narrowed(collaboratorShare) : Stream.empty))),
        );
      });
    return changes.pipe(
      Stream.map((shares) => shares.get(subject)),
      Stream.changesWith(sameShare),
      Stream.switchMap(narrowed),
    );
  };

  const accessChanges = (subject: string, threadId: string) =>
    changes.pipe(
      Stream.map((shares) => {
        const share = shares.get(subject);
        if (share?.threadIds.has(threadId)) return "live" as const;
        return share?.frozen.has(threadId) ? ("frozen" as const) : ("none" as const);
      }),
      Stream.changes,
    );

  const rpcRefusal = (subject: string, method: string, payload: unknown) => {
    if (COLLABORATOR_OPEN_RPCS.has(method)) return undefined;
    const threadId = COLLABORATOR_THREAD_RPCS.has(method)
      ? payloadThreadId(payload)
      : method === WS_METHODS.assetsCreateUrl
        ? assetThreadId(payload)
        : undefined;
    if (threadId === null) return undefined;
    if (threadId === undefined) return notCollaboratorRpc;
    return isShared(subject, threadId) ? undefined : notShared(AuthOrchestrationReadScope);
  };

  const guardRpc: Service["guardRpc"] = (subject) =>
    Effect.updateService(RpcScopeAuthorization, (authorize) =>
      isCollaboratorSubject(subject)
        ? (effect, options) => {
            const refusal = rpcRefusal(subject, options.rpc._tag, options.payload);
            return refusal === undefined ? authorize(effect, options) : Effect.fail(refusal);
          }
        : authorize,
    );

  const messageHandlers: Service["messageHandlers"] = (subject) =>
    subject === null || !isCollaboratorSubject(subject)
      ? {
          [MESSAGES]: () =>
            // The host's work is what still waits; a dismissed message is its author's to clear.
            messages.visible(
              (message) =>
                message.outcome === undefined && isShared(message.subject, message.threadId),
            ),
          [SUBMIT]: () => Effect.fail(notCollaborator),
          [RESOLVE]: (input) => messages.resolve(input, null),
        }
      : collaboratorMessageHandlers(subject);

  const collaboratorMessageHandlers = (subject: string): CollaboratorMessageHandlersFork => ({
    [MESSAGES]: () =>
      messages.visible(
        (message) => message.subject === subject && isShared(subject, message.threadId),
      ),
    // Checked inside `exclusive`, so an unshare in flight finishes first.
    [SUBMIT]: (input) =>
      messages.exclusive(
        Effect.suspend((): Effect.Effect<void, MessageError> => {
          const share = current().get(subject);
          // A collaborator with `send` access dispatches like the host; this path is for `approve`.
          return share?.threadIds.get(input.threadId) === "approve"
            ? messages.submit({ subject, name: share.name, ...input })
            : Effect.fail(notShared(AuthOrchestrationOperateScope));
        }),
      ),
    // A collaborator can withdraw or clear a message, never send it past the host.
    [RESOLVE]: (input) =>
      input.decision === "dismiss"
        ? messages.resolve(input, subject)
        : Effect.fail(notShared(AuthOrchestrationOperateScope)),
  });

  const typingContext = (
    threadId: string,
    shared: (shares: Shares) => boolean,
    you: (shares: Shares) => string | undefined,
  ) =>
    changes.pipe(
      Stream.map((shares) => ({
        shared: shared(shares),
        people: peopleOf(shares, threadId),
        you: you(shares),
      })),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );

  const typingHandlers: Service["typingHandlers"] = (subject) => {
    if (subject === null || !isCollaboratorSubject(subject)) {
      return {
        [SET_TYPING]: ({ threadId, typing: on, ...writing }) => {
          const typist = { ...HOST_TYPIST, ...writing };
          return on ? typing.start(threadId, typist) : typing.stop(threadId, typist);
        },
        [TYPING]: ({ threadId }) =>
          typing.state(
            threadId,
            HOST_TYPIST.subject,
            typingContext(
              threadId,
              (shares) => [...shares.values()].some((share) => share.threadIds.has(threadId)),
              () => undefined,
            ),
          ),
      };
    }
    return {
      [SET_TYPING]: ({ threadId, typing: on, ...writing }) => {
        if (!on) return typing.stop(threadId, { subject, ...writing });
        const share = current().get(subject);
        return share?.threadIds.has(threadId)
          ? typing.start(threadId, { subject, name: share.name, ...writing })
          : Effect.fail(notShared(AuthOrchestrationOperateScope));
      },
      [TYPING]: ({ threadId }) =>
        typing.state(
          threadId,
          subject,
          typingContext(
            threadId,
            (shares) => shares.get(subject)?.threadIds.has(threadId) === true,
            (shares) => shares.get(subject)?.name,
          ),
        ),
    };
  };

  /** Who wrote a queued run's message, as the server attributed it; undefined refuses. */
  const queuedAuthor = Effect.fn("CollaboratorSharesFork.queuedAuthor")(
    function* (threadId: ThreadId, runId: RunId) {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
      const run = runs.find((candidate) => candidate.id === runId);
      if (run === undefined) return undefined;
      const messages = yield* threads.getMessagesById(threadId, [run.userMessageId]);
      return messages.get(run.userMessageId)?.context?.collaboratorFork?.name;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const wrapHandlers: Service["wrapHandlers"] = (subject, handlers) => {
    // The caller assigns the result back onto `handlers`, so capture the originals now.
    const { [DISPATCH]: dispatch, [SHELL]: subscribeShell, [THREAD]: subscribeThread } = handlers;
    const { [LAUNCH]: launch } = handlers;
    if (!isCollaboratorSubject(subject)) {
      return {
        ...handlers,
        [DISPATCH]: (command, options) => {
          const clean = withoutCollaboratorAttribution(command);
          if (clean.type !== "message.dispatch" && clean.type !== "queued-run.edit") {
            return dispatch(clean, options);
          }
          const others = [...current().values()]
            .filter((share) => share.threadIds.has(clean.threadId))
            .map((share) => share.name);
          // A prefix would hide a native command such as /compact from the provider.
          if (others.length === 0 || clean.text.trimStart().startsWith("/")) {
            return dispatch(clean, options);
          }
          return hostName.pipe(
            Effect.flatMap((host) => {
              const attribution = hostAttribution(host, others, clean.text);
              return dispatch(
                {
                  ...clean,
                  text: attribution.text,
                  context: { version: 1, records: [], ...clean.context, ...attribution.context },
                },
                options,
              );
            }),
          );
        },
        [LAUNCH]: (input, options) => launch(launchWithoutAttribution(input), options),
      };
    }
    return {
      ...messageHandlers(subject),
      ...typingHandlers(subject),
      // Outside the collaborator's closed RPC set, so `guardRpc` refuses it first.
      [LAUNCH]: launch,
      [DISPATCH]: (command, options) => {
        const share = current().get(subject);
        const access = share?.threadIds.get(commandThreadId(command));
        if (share === undefined || access === undefined) {
          return Effect.fail(notShared(AuthOrchestrationOperateScope));
        }
        if (access === "approve") return Effect.fail(needsApproval);
        if (command.type === "queued-run.edit" || command.type === "queued-run.cancel") {
          return queuedAuthor(command.threadId, command.runId).pipe(
            Effect.flatMap((author) =>
              author !== undefined && collaboratorSubject(author) === subject
                ? Effect.void
                : Effect.fail(hostOnly),
            ),
            Effect.andThen(() =>
              dispatch(
                command.type === "queued-run.edit" ? attributed(share.name, command) : command,
                options,
              ),
            ),
          );
        }
        if (!COLLABORATOR_COMMANDS.has(command.type)) return Effect.fail(hostOnly);
        if (command.type !== "message.dispatch") return dispatch(command, options);
        return dispatch(attributed(share.name, command), options);
      },
      [SHELL]: (input, options) => shell(subject, input, (fresh) => subscribeShell(fresh, options)),
      // Unshared pauses silently, since the client retries a failed stream every 250ms.
      // A frozen thread reports its cached copy current; a re-share resumes after the last
      // sequence sent.
      [THREAD]: (input, options) => {
        let afterSequence = input.afterSequence;
        return accessChanges(subject, input.threadId).pipe(
          Stream.switchMap((access) =>
            access === "live"
              ? subscribeThread(
                  afterSequence === undefined ? input : { ...input, afterSequence },
                  options,
                ).pipe(
                  Stream.tap((item) =>
                    Effect.sync(() => {
                      afterSequence = Math.max(afterSequence ?? 0, itemSequence(item));
                    }),
                  ),
                )
              : access === "frozen"
                ? Stream.make({ kind: "synchronized" as const })
                : Stream.empty,
          ),
        );
      },
    };
  };

  // A frozen copy cannot follow up, so its waiting messages go first, and no submit lands
  // between them and `persist`. A failure leaves the share live, and a retry repeats every step.
  const endShare = Effect.fn("CollaboratorSharesFork.endShare")(function* (
    subject: string,
    threadId: ThreadId,
    persist: Effect.Effect<void, CollaboratorUnshareErrorFork>,
  ) {
    yield* messages.exclusive(
      messages.drop(subject, threadId).pipe(
        Effect.mapError(
          (cause) =>
            new CollaboratorUnshareErrorFork({ operation: "freeze-share", threadId, cause }),
        ),
        Effect.andThen(persist),
      ),
    );
    yield* typing.drop(threadId, subject);
  });

  return { handlers: { messageHandlers, typingHandlers, guardRpc, wrapHandlers }, endShare };
});
