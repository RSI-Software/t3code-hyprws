// Fork-only (colleague-collab): adapts one session's RPC handlers to the threads shared with it.
// A collaborator session reaches a closed RPC set and a closed command set, attributed to them;
// the host's messages name the host to the agent. Share state stays in `CollaboratorShares.fork.ts`.
// A saved colleague also reads every team project thread (`TeamThreads.fork.ts`), never writing.
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
  type OrchestrationMessageContext,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2SubscribeShellInput,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2SubscribeCommandOutputInput,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  OrchestrationV2DispatchCommandError,
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
import { makeTeamThreads } from "./TeamThreads.fork.ts";

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

/** What one collaborator session reads: its hand shares, and the team projects of a colleague. */
interface ShellView {
  readonly share: CollaboratorShare | undefined;
  /** Team project ids; empty for a one-time guest. */
  readonly team: ReadonlySet<string>;
}

/** What the session was last sent: a snapshot resets both to what it holds. */
interface ShellVisible {
  readonly projects: Set<string>;
  /** Projects holding a hand-shared or frozen thread, so they stay visible outside the team. */
  readonly shareProjects: Set<string>;
  /** Live threads only; a frozen copy never updates. */
  readonly threads: Set<string>;
}

/** Narrows one shell item; an authoritative snapshot resets `visible` to the readable threads'. */
const filterShellItem = (
  { share, team }: ShellView,
  visible: ShellVisible,
  item: OrchestrationV2ShellStreamItem,
): OrchestrationV2ShellStreamItem | undefined => {
  const { projects, shareProjects } = visible;
  // A project item passes while the project is team now or holds a hand-shared thread.
  const projectReadable = (id: string) =>
    projects.has(id) && (team.has(id) || shareProjects.has(id));
  // A hand share keeps its access; a team thread only reads.
  const accessOf = (thread: { readonly id: string; readonly projectId: string }) =>
    share?.threadIds.get(thread.id) ?? (team.has(thread.projectId) ? ("read" as const) : undefined);
  // The collaborator's client reads its access from the thread itself.
  const readable = <T extends OrchestrationV2ThreadShell>(thread: T) => {
    const access = accessOf(thread);
    return access === undefined ? [] : [{ ...thread, collaboratorFork: access }];
  };
  switch (item.kind) {
    case "synchronized":
      return item;
    case "snapshot": {
      const { olderSettled: _olderSettled, ...snapshot } = item.snapshot;
      // An enrichment snapshot only refreshes project metadata and carries no threads.
      if (item.resolvedRepositoryIdentityRoots !== undefined) {
        const readableProjects = snapshot.projects.filter((project) => projectReadable(project.id));
        const roots = new Set(readableProjects.map((project) => project.workspaceRoot));
        return {
          ...item,
          snapshot: { ...snapshot, projects: readableProjects },
          resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots.filter((root) =>
            roots.has(root),
          ),
        };
      }
      const live = snapshot.threads.flatMap(readable);
      const liveArchived = snapshot.archivedThreads.flatMap(readable);
      visible.threads.clear();
      for (const thread of [...live, ...liveArchived]) visible.threads.add(thread.id);
      // A frozen copy stands in for the live thread, so it never reveals later changes.
      const frozen = frozenShells(share).filter((thread) => !visible.threads.has(thread.id));
      const threads = [...live, ...frozen.filter((thread) => thread.archivedAt === null)];
      const archivedThreads = [
        ...liveArchived,
        ...frozen.filter((thread) => thread.archivedAt !== null),
      ];
      projects.clear();
      shareProjects.clear();
      for (const id of team) projects.add(id);
      for (const thread of [...threads, ...archivedThreads]) {
        projects.add(thread.projectId);
        if (thread.collaboratorFork !== "read") shareProjects.add(thread.projectId);
      }
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
      return projectReadable(item.project.id) ? item : undefined;
    case "project.removed":
      return projectReadable(item.projectId) ? item : undefined;
    case "thread.updated": {
      const [thread] = readable(item.thread);
      if (thread !== undefined) {
        visible.threads.add(thread.id);
        if (thread.collaboratorFork !== "read") shareProjects.add(thread.projectId);
        return { ...item, thread };
      }
      // A team thread moved to another project leaves the view.
      if (!visible.threads.delete(item.thread.id)) return undefined;
      const { sequence, location } = item;
      return { kind: "thread.removed", sequence, location, threadId: item.thread.id };
    }
    case "thread.removed":
      return visible.threads.delete(item.threadId) ? item : undefined;
  }
};

const {
  dispatchCommand: DISPATCH,
  launchThread: LAUNCH,
  subscribeShell: SHELL,
  subscribeThread: THREAD,
  subscribeCommandOutput: OUTPUT,
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
export interface CollaboratorHandlersFork<A, E, R, SE, SR, TE, TR, LA, LE, LR, OE, OR> {
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
  readonly [OUTPUT]: (
    input: OrchestrationV2SubscribeCommandOutputInput,
    options: never,
  ) => Stream.Stream<OrchestrationV2CommandOutputFrame, OE, OR>;
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

/** The sender chose "Ask the agent", so the agent answers without judging who the line is for. */
const forcedReply = (command: { readonly context?: OrchestrationMessageContext | undefined }) =>
  command.context?.forceReplyFork === true;

/** Names the collaborator in the text the agent reads; their own words ride the context. */
const attributed = <Command extends Extract<OrchestrationV2Command, { readonly text: string }>>(
  name: string,
  command: Command,
): Command => {
  const attribution = collaboratorAttribution(name, command.text, forcedReply(command));
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

const readOnly = new EnvironmentAuthorizationError({
  message: "Team project threads are read-only for colleagues.",
  requiredScope: AuthOrchestrationOperateScope,
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
// Writing and presence need a live hand share; the reads also serve a team thread.
const SHARE_ONLY_RPCS: ReadonlySet<string> = new Set([SUBMIT, RESOLVE, SET_TYPING, TYPING]);
const COLLABORATOR_THREAD_RPCS: ReadonlySet<string> = new Set([
  ...SHARE_ONLY_RPCS,
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
  /** Who can see a thread now, which the host's messages there name for the agent. */
  const sharedNames = (threadId: string) =>
    [...current().values()]
      .filter((share) => share.threadIds.has(threadId))
      .map((share) => share.name);
  const typing = yield* makeCollaboratorTyping;
  const teamThreads = yield* makeTeamThreads;
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
  const messages = yield* makeCollaboratorMessages((threadId) =>
    hostName.pipe(Effect.map((host) => ({ host, others: sharedNames(threadId) }))),
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
    const narrowed = (view: ShellView): Stream.Stream<OrchestrationV2ShellStreamItem, SE, SR> =>
      Stream.suspend(() => {
        const visible: ShellVisible = {
          projects: new Set(),
          shareProjects: new Set(),
          threads: new Set(),
        };
        let moved = false;
        return open(fresh).pipe(
          // Team access rereads the committed marks, so no item leaves after an unmark.
          Stream.mapEffect((item) =>
            (view.team.size === 0
              ? Effect.succeed(view)
              : Effect.map(teamThreads.marksOf(subject), (team) => ({ ...view, team }))
            ).pipe(Effect.map((current) => filterShellItem(current, visible, item))),
          ),
          Stream.filter(Predicate.isNotUndefined),
          Stream.takeUntil(
            (item) =>
              (moved =
                item.kind === "thread.updated" && !visible.projects.has(item.thread.projectId)),
            { excludeLast: true },
          ),
          Stream.concat(Stream.suspend(() => (moved ? narrowed(view) : Stream.empty))),
        );
      });
    // A colleague's view also re-snapshots when a project is marked or unmarked team.
    return Stream.zipLatest(
      changes.pipe(
        Stream.map((shares) => shares.get(subject)),
        Stream.changesWith(sameShare),
      ),
      teamMarks(subject).pipe(Stream.changesWith<ReadonlySet<string>>(sameIds)),
    ).pipe(
      Stream.map(([share, team]): ShellView => ({ share, team })),
      Stream.switchMap(narrowed),
    );
  };

  // Untraced: it gates every command output frame.
  const canRead: Service["canRead"] = Effect.fnUntraced(function* (subject, threadId) {
    return isShared(subject, threadId) || (yield* teamThreads.readable(subject, threadId));
  });

  const NO_TEAM: ReadonlySet<string> = new Set();
  /** The team projects a subject reads, now and on every touch; none for a one-time guest. */
  const teamMarks = (subject: string) =>
    teamThreads.changes.pipe(
      // A failed watcher publishes none, and lists none until it reads fresh marks.
      Stream.mapEffect((marks) =>
        marks.size === 0 ? Effect.succeed(NO_TEAM) : teamThreads.marksOf(subject),
      ),
    );

  // Each touch rechecks access; `team` is read access through a team project, which every
  // frame rechecks too, so none leaves once the thread or project leaves the team.
  const accessChanges = (subject: string, threadId: string) =>
    Stream.zipLatest(changes, teamMarks(subject)).pipe(
      Stream.mapEffect(([shares]) => {
        const share = shares.get(subject);
        if (share?.threadIds.has(threadId)) return Effect.succeed("live" as const);
        const stopped = share?.frozen.has(threadId) ? ("frozen" as const) : ("none" as const);
        return teamThreads
          .readable(subject, threadId)
          .pipe(Effect.map((read) => (read ? ("team" as const) : stopped)));
      }),
      Stream.changes,
    );

  const rpcRefusal = Effect.fn("CollaboratorSharesFork.rpcRefusal")(function* (
    subject: string,
    method: string,
    payload: unknown,
  ) {
    if (COLLABORATOR_OPEN_RPCS.has(method)) return undefined;
    const threadId = COLLABORATOR_THREAD_RPCS.has(method)
      ? payloadThreadId(payload)
      : method === WS_METHODS.assetsCreateUrl
        ? assetThreadId(payload)
        : undefined;
    if (threadId === null) return undefined;
    if (threadId === undefined) return notCollaboratorRpc;
    const read = SHARE_ONLY_RPCS.has(method)
      ? isShared(subject, threadId)
      : yield* canRead(subject, threadId);
    return read ? undefined : notShared(AuthOrchestrationReadScope);
  });

  const guardRpc: Service["guardRpc"] = (subject) =>
    Effect.updateService(RpcScopeAuthorization, (authorize) =>
      isCollaboratorSubject(subject)
        ? (effect, options) =>
            rpcRefusal(subject, options.rpc._tag, options.payload).pipe(
              Effect.flatMap((refusal) =>
                refusal === undefined ? authorize(effect, options) : Effect.fail(refusal),
              ),
            )
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

  /**
   * A queued run's message attribution, as the server wrote it. A failed read refuses the
   * command, since guessing would drop a reply's quote or an author's claim.
   */
  const queuedAttribution = Effect.fn("CollaboratorSharesFork.queuedAttribution")(
    function* (
      command: Extract<
        OrchestrationV2Command,
        { readonly type: "queued-run.edit" | "queued-run.cancel" }
      >,
    ) {
      const { threadId, runId } = command;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
      const run = runs.find((candidate) => candidate.id === runId);
      if (run === undefined) return undefined;
      const messages = yield* threads.getMessagesById(threadId, [run.userMessageId]);
      return messages.get(run.userMessageId)?.context?.collaboratorFork;
    },
    (effect, command) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2DispatchCommandError({
              commandId: command.commandId,
              commandType: command.type,
              message: "Could not read the queued message. Try again.",
              cause,
            }),
        ),
      ),
  );

  /**
   * The host's line as the agent reads it; an edit keeps the waiting message a reply answers,
   * even once nobody shares the thread. Undefined sends the line as typed.
   */
  const hostLine = Effect.fn("CollaboratorSharesFork.hostLine")(function* (
    command: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" | "queued-run.edit" }
    >,
  ) {
    const replyTo =
      command.type === "queued-run.edit" ? (yield* queuedAttribution(command))?.replyTo : undefined;
    const others = sharedNames(command.threadId);
    if (others.length === 0 && replyTo === undefined) return undefined;
    const host = yield* hostName;
    const attribution = hostAttribution(host, others, command.text, forcedReply(command), replyTo);
    const attributed: OrchestrationV2Command = {
      ...command,
      text: attribution.text,
      context: { version: 1, records: [], ...command.context, ...attribution.context },
    };
    return attributed;
  });

  const wrapHandlers: Service["wrapHandlers"] = (subject, handlers) => {
    // The caller assigns the result back onto `handlers`, so capture the originals now.
    const { [DISPATCH]: dispatch, [SHELL]: subscribeShell, [THREAD]: subscribeThread } = handlers;
    const { [LAUNCH]: launch, [OUTPUT]: subscribeOutput } = handlers;
    if (!isCollaboratorSubject(subject)) {
      return {
        ...handlers,
        [DISPATCH]: (command, options) => {
          const clean = withoutCollaboratorAttribution(command);
          if (clean.type !== "message.dispatch" && clean.type !== "queued-run.edit") {
            return dispatch(clean, options);
          }
          // A prefix would hide a native command such as /compact from the provider.
          if (clean.text.trimStart().startsWith("/")) return dispatch(clean, options);
          return hostLine(clean).pipe(
            Effect.flatMap((attributed) => dispatch(attributed ?? clean, options)),
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
          return canRead(subject, commandThreadId(command)).pipe(
            Effect.flatMap((read) =>
              Effect.fail(read ? readOnly : notShared(AuthOrchestrationOperateScope)),
            ),
          );
        }
        if (access === "approve") return Effect.fail(needsApproval);
        if (command.type === "queued-run.edit" || command.type === "queued-run.cancel") {
          return queuedAttribution(command).pipe(
            Effect.flatMap((author) =>
              author !== undefined && collaboratorSubject(author.name) === subject
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
      // Output is live only; it ends at the first frame after read access ends.
      [OUTPUT]: (input, options) =>
        subscribeOutput(input, options).pipe(
          Stream.takeWhileEffect(() => canRead(subject, input.threadId)),
        ),
      [THREAD]: (input, options) => {
        let afterSequence = input.afterSequence;
        return accessChanges(subject, input.threadId).pipe(
          Stream.switchMap((access) =>
            access === "live" || access === "team"
              ? subscribeThread(
                  afterSequence === undefined ? input : { ...input, afterSequence },
                  options,
                ).pipe(
                  Stream.filterEffect(() =>
                    access === "team"
                      ? teamThreads.readable(subject, input.threadId)
                      : Effect.succeed(true),
                  ),
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

  return {
    handlers: {
      messageHandlers,
      typingHandlers,
      guardRpc,
      wrapHandlers,
      canRead,
      colleaguesChanged: teamThreads.touch,
    },
    endShare,
  };
});
