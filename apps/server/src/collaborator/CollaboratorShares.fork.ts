// Fork-only (colleague-collab): share one thread with a collaborator through a pairing link.
// Their session reaches a closed RPC set, narrowed to the threads shared with its subject.
// Unsharing freezes their copy; `approve` access holds messages in `CollaboratorMessages.fork.ts`.
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  COLLABORATOR_SCOPES,
  COLLABORATOR_THREAD_LINK_PARAM,
  CollaboratorAccessFork,
  CollaboratorAccessErrorFork,
  type CollaboratorMessageErrorFork,
  type CollaboratorMessageFork,
  type CollaboratorResolveMessageInputFork,
  type CollaboratorSetAccessInputFork,
  CollaboratorShareErrorFork,
  type CollaboratorSubmitMessageInputFork,
  type CollaboratorShareThreadInputFork,
  type CollaboratorShareThreadResultFork,
  CollaboratorThreadMissingErrorFork,
  type CollaboratorThreadSharesResultFork,
  CollaboratorUnshareErrorFork,
  type CollaboratorUnshareThreadInputFork,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2SubscribeShellInput,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  RpcScopeAuthorization,
  WS_METHODS,
} from "@t3tools/contracts";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient } from "effect/http";

import { failEnvironmentScopeRequired } from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  buildPairingUrl,
  isLoopbackHost,
  resolveHeadlessConnectionString,
} from "../startupAccess.ts";
import { collaboratorAttribution, makeCollaboratorMessages } from "./CollaboratorMessages.fork.ts";
import { discoverTunnelOrigin } from "./tunnelOrigin.fork.ts";

// Persisted in paired sessions, so it keeps the feature's original name.
const COLLABORATOR_SUBJECT_PREFIX = "colleague:";
const SHARE_LINK_TTL = Duration.hours(24);

const isCollaboratorSubject = (subject: string) => subject.startsWith(COLLABORATOR_SUBJECT_PREFIX);

// Case and punctuation fold on purpose, so "Sam" and "sam " reach the same paired collaborator.
const collaboratorSubject = (name: string) =>
  `${COLLABORATOR_SUBJECT_PREFIX}${name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")}`;

interface CollaboratorShare {
  readonly name: string;
  /** Live shares, each with what the collaborator's messages may do. */
  readonly threadIds: ReadonlyMap<string, CollaboratorAccessFork>;
  /** Stopped shares: the thread's shell as it was when sharing stopped. */
  readonly frozen: ReadonlyMap<string, OrchestrationV2ThreadShell>;
}

interface ShareRow {
  readonly subject: string;
  readonly thread_id: string;
  readonly colleague_name: string;
  readonly frozen_shell_json: string | null;
  readonly access: string | null;
}

const isAccess = Schema.is(CollaboratorAccessFork);

const FrozenShellJson = Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadShell));
const encodeFrozenShell = Schema.encodeEffect(FrozenShellJson);
const decodeFrozenShell = Schema.decodeUnknownOption(FrozenShellJson);

const sharesFromRows = (rows: ReadonlyArray<ShareRow>) => {
  const shares = new Map<string, CollaboratorShare>();
  for (const row of rows) {
    const prior = shares.get(row.subject);
    const threadIds = new Map(prior?.threadIds);
    const frozen = new Map(prior?.frozen);
    if (row.frozen_shell_json === null) {
      threadIds.set(row.thread_id, isAccess(row.access) ? row.access : "approve");
    } else {
      const shell = decodeFrozenShell(row.frozen_shell_json);
      if (Option.isSome(shell)) frozen.set(row.thread_id, shell.value);
    }
    shares.set(row.subject, { name: row.colleague_name, threadIds, frozen });
  }
  return shares;
};

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
} = WS_METHODS;

type MessageError = CollaboratorMessageErrorFork | EnvironmentAuthorizationError;

/** The waiting-message RPCs, answered per session: `null` is the host, who sees and sends all. */
interface CollaboratorMessageHandlersFork {
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

// `options: never` accepts each upstream handler whatever its RPC options type.
interface CollaboratorHandlersFork<A, E, R, SE, SR, TE, TR, LA, LE, LR> {
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
]);
const COLLABORATOR_THREAD_RPCS: ReadonlySet<string> = new Set([
  SUBMIT,
  RESOLVE,
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

/** Accepts a share's link base only as a non-loopback http(s) origin. */
const publicOrigin = (url: string | undefined) => {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const { protocol, hostname, origin } = new URL(url);
  return (protocol === "https:" || protocol === "http:") && !isLoopbackHost(hostname)
    ? origin
    : undefined;
};

export class CollaboratorSharesFork extends Context.Service<
  CollaboratorSharesFork,
  {
    readonly share: (
      input: CollaboratorShareThreadInputFork,
    ) => Effect.Effect<
      CollaboratorShareThreadResultFork,
      CollaboratorShareErrorFork | CollaboratorThreadMissingErrorFork
    >;
    readonly threadShares: (threadId: string) => Effect.Effect<CollaboratorThreadSharesResultFork>;
    readonly unshare: (
      input: CollaboratorUnshareThreadInputFork,
    ) => Effect.Effect<void, CollaboratorUnshareErrorFork>;
    readonly setAccess: (
      input: CollaboratorSetAccessInputFork,
    ) => Effect.Effect<void, CollaboratorAccessErrorFork>;
    /** The waiting-message handlers for `subject`, or the host's for `null`. */
    readonly messageHandlers: (subject: string | null) => CollaboratorMessageHandlersFork;
    /**
     * Wraps the session's RPC authorization: a collaborator session is also refused outside its
     * closed set; other sessions pass through.
     */
    readonly guardRpc: (
      subject: string,
    ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | RpcScopeAuthorization>;
    /** Whether the thread is shared live with the subject. */
    readonly isShared: (subject: string, threadId: string) => boolean;
    /**
     * Narrows a collaborator session's thread handlers and answers its waiting messages; other
     * sessions only lose the right to attribute a message to a collaborator.
     */
    readonly wrapHandlers: <A, E, R, SE, SR, TE, TR, LA, LE, LR>(
      subject: string,
      handlers: CollaboratorHandlersFork<A, E, R, SE, SR, TE, TR, LA, LE, LR>,
    ) => CollaboratorHandlersFork<
      A,
      E | EnvironmentAuthorizationError,
      R,
      SE,
      SR,
      TE | EnvironmentAuthorizationError,
      TR,
      LA,
      LE,
      LR
    > &
      Partial<CollaboratorMessageHandlersFork>;
  }
>()("t3/collaborator/CollaboratorShares.fork/CollaboratorSharesFork") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const httpClient = yield* HttpClient.HttpClient;
  const messages = yield* makeCollaboratorMessages;
  // The local tunnel's public hostname, then the origin the sharing client reached, then a guess.
  const pairingBaseUrl = Effect.fn("CollaboratorSharesFork.pairingBaseUrl")(function* (
    linkBaseUrl: string | undefined,
  ) {
    const tunnelOrigin = yield* discoverTunnelOrigin(config.port).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const base =
      tunnelOrigin ??
      publicOrigin(linkBaseUrl) ??
      config.devUrl?.origin ??
      resolveHeadlessConnectionString(config.host, config.port, {
        privateNetworkOnly: config.privateNetworkOnly,
      });
    const { hostname } = new URL(base);
    return { base, localOnly: isPrivateNetworkHost(hostname) };
  });

  const readShares = sql<ShareRow>`
    SELECT subject, thread_id, colleague_name, frozen_shell_json, access FROM fork_colleague_shares
    ORDER BY created_at
  `.pipe(Effect.map(sharesFromRows));
  let current: ReadonlyMap<string, CollaboratorShare> = yield* readShares.pipe(Effect.orDie);
  const ref = yield* SubscriptionRef.make(current);
  const reload = readShares.pipe(
    Effect.flatMap((next) => {
      current = next;
      return SubscriptionRef.set(ref, next);
    }),
  );

  const share = Effect.fn("CollaboratorSharesFork.share")(function* (
    input: CollaboratorShareThreadInputFork,
  ) {
    const { threadId } = input;
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new CollaboratorShareErrorFork({ operation: "read-thread", threadId, cause }),
        ),
      );
    if (thread === null || thread.deletedAt !== null) {
      return yield* new CollaboratorThreadMissingErrorFork({ threadId });
    }
    const subject = collaboratorSubject(input.collaboratorName);
    const knownCollaborator = yield* auth.listSessions().pipe(
      Effect.map((sessions) => sessions.some((session) => session.subject === subject)),
      Effect.orElseSucceed(() => false),
    );
    // Minted first so a failure grants nothing; a paired collaborator may still need it for a new device.
    const issued = yield* auth
      .createPairingLink({
        subject,
        label: `Collaborator ${input.collaboratorName}`,
        scopes: COLLABORATOR_SCOPES,
        ttl: SHARE_LINK_TTL,
      })
      .pipe(
        Effect.mapError(
          (cause) => new CollaboratorShareErrorFork({ operation: "pair", threadId, cause }),
        ),
      );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const access = input.access ?? null;
    yield* sql`
      INSERT INTO fork_colleague_shares (subject, thread_id, colleague_name, created_at, access)
      VALUES (${subject}, ${thread.id}, ${input.collaboratorName}, ${createdAt}, ${access ?? "approve"})
      ON CONFLICT (subject, thread_id) DO UPDATE
      SET frozen_shell_json = NULL, access = COALESCE(${access}, access)
    `.pipe(
      Effect.mapError(
        (cause) => new CollaboratorShareErrorFork({ operation: "record-share", threadId, cause }),
      ),
    );
    yield* reload.pipe(
      Effect.mapError(
        (cause) => new CollaboratorShareErrorFork({ operation: "read-shares", threadId, cause }),
      ),
    );
    // Pairing ignores the query, so the thread rides inside the pairing URL to the collaborator's app.
    const { base, localOnly } = yield* pairingBaseUrl(input.linkBaseUrl);
    const pairing = new URL(buildPairingUrl(base, issued.credential));
    pairing.searchParams.set(COLLABORATOR_THREAD_LINK_PARAM, thread.id);
    return { pairingUrl: pairing.toString(), localOnly, knownCollaborator };
  });

  const isShared = (subject: string, threadId: string) =>
    current.get(subject)?.threadIds.has(threadId) === true;

  const threadShares: CollaboratorSharesFork["Service"]["threadShares"] = (threadId) =>
    Effect.sync(() => {
      const collaborators = [...current].map(([subject, { name }]) => ({ subject, name }));
      return {
        sharedWith: collaborators.flatMap((collaborator) => {
          const access = current.get(collaborator.subject)?.threadIds.get(threadId);
          return access === undefined ? [] : [{ ...collaborator, access }];
        }),
        collaborators,
      };
    });

  // Freezes the collaborator's copy; a thread already gone leaves nothing to freeze.
  const unshare = Effect.fn("CollaboratorSharesFork.unshare")(function* (
    input: CollaboratorUnshareThreadInputFork,
  ) {
    const { subject, threadId } = input;
    const fail = (operation: CollaboratorUnshareErrorFork["operation"]) => (cause: unknown) =>
      new CollaboratorUnshareErrorFork({ operation, threadId, cause });
    if (!isShared(subject, threadId)) return;
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(fail("freeze-share")));
    const frozen =
      thread === null || thread.deletedAt !== null
        ? null
        : yield* encodeFrozenShell(thread).pipe(Effect.mapError(fail("freeze-share")));
    // A frozen copy cannot follow up, so its waiting messages go first, and no submit lands
    // between. A failure leaves the share live, and a retry repeats every step.
    yield* messages.exclusive(
      Effect.gen(function* () {
        yield* messages.drop(subject, threadId).pipe(Effect.mapError(fail("freeze-share")));
        yield* (
          frozen === null
            ? sql`
                DELETE FROM fork_colleague_shares
                WHERE subject = ${subject} AND thread_id = ${threadId}
              `
            : sql`
                UPDATE fork_colleague_shares SET frozen_shell_json = ${frozen}
                WHERE subject = ${subject} AND thread_id = ${threadId}
              `
        ).pipe(Effect.mapError(fail("freeze-share")));
        yield* reload.pipe(Effect.mapError(fail("read-shares")));
      }),
    );
  });

  const setAccess = Effect.fn("CollaboratorSharesFork.setAccess")(function* (
    input: CollaboratorSetAccessInputFork,
  ) {
    const { subject, threadId, access } = input;
    const fail = (cause: unknown) => new CollaboratorAccessErrorFork({ threadId, cause });
    yield* sql`
      UPDATE fork_colleague_shares SET access = ${access}
      WHERE subject = ${subject} AND thread_id = ${threadId} AND frozen_shell_json IS NULL
    `.pipe(Effect.mapError(fail));
    yield* reload.pipe(Effect.mapError(fail));
  });

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
    return SubscriptionRef.changes(ref).pipe(
      Stream.map((shares) => shares.get(subject)),
      Stream.changesWith(sameShare),
      Stream.switchMap(narrowed),
    );
  };

  const accessChanges = (subject: string, threadId: string) =>
    SubscriptionRef.changes(ref).pipe(
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

  const guardRpc: CollaboratorSharesFork["Service"]["guardRpc"] = (subject) =>
    Effect.updateService(RpcScopeAuthorization, (authorize) =>
      isCollaboratorSubject(subject)
        ? (effect, options) => {
            const refusal = rpcRefusal(subject, options.rpc._tag, options.payload);
            return refusal === undefined ? authorize(effect, options) : Effect.fail(refusal);
          }
        : authorize,
    );

  const messageHandlers = (subject: string | null): CollaboratorMessageHandlersFork =>
    subject === null || !isCollaboratorSubject(subject)
      ? {
          [MESSAGES]: () =>
            messages.visible((message) => isShared(message.subject, message.threadId)),
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
          const share = current.get(subject);
          // A collaborator with `send` access dispatches like the host; this path is for `approve`.
          return share?.threadIds.get(input.threadId) === "approve"
            ? messages.submit({ subject, name: share.name, ...input })
            : Effect.fail(notShared(AuthOrchestrationOperateScope));
        }),
      ),
    // A collaborator can withdraw a message, never send it past the host.
    [RESOLVE]: (input) =>
      input.decision === "dismiss"
        ? messages.resolve(input, subject)
        : Effect.fail(notShared(AuthOrchestrationOperateScope)),
  });

  const wrapHandlers: CollaboratorSharesFork["Service"]["wrapHandlers"] = (subject, handlers) => {
    // The caller assigns the result back onto `handlers`, so capture the originals now.
    const { [DISPATCH]: dispatch, [SHELL]: subscribeShell, [THREAD]: subscribeThread } = handlers;
    const { [LAUNCH]: launch } = handlers;
    if (!isCollaboratorSubject(subject)) {
      return {
        ...handlers,
        [DISPATCH]: (command, options) =>
          dispatch(withoutCollaboratorAttribution(command), options),
        [LAUNCH]: (input, options) => launch(launchWithoutAttribution(input), options),
      };
    }
    return {
      ...messageHandlers(subject),
      // Outside the collaborator's closed RPC set, so `guardRpc` refuses it first.
      [LAUNCH]: launch,
      [DISPATCH]: (command, options) => {
        const share = current.get(subject);
        const access = share?.threadIds.get(commandThreadId(command));
        if (share === undefined || access === undefined) {
          return Effect.fail(notShared(AuthOrchestrationOperateScope));
        }
        if (access === "approve") return Effect.fail(needsApproval);
        if (command.type !== "message.dispatch" && command.type !== "queued-run.edit") {
          return dispatch(command, options);
        }
        const attribution = collaboratorAttribution(share.name, command.text);
        return dispatch(
          {
            ...command,
            text: attribution.text,
            context: { version: 1, records: [], ...command.context, ...attribution.context },
          },
          options,
        );
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

  return CollaboratorSharesFork.of({
    share,
    threadShares,
    unshare,
    setAccess,
    messageHandlers,
    guardRpc,
    isShared,
    wrapHandlers,
  });
});

export const layer = Layer.effect(CollaboratorSharesFork, make);

/** Collaborator sessions read the shell over the socket, where it is filtered; refuse the HTTP copy. */
export const refuseCollaboratorHttpShellFork = Effect.gen(function* () {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (isCollaboratorSubject(principal.subject)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
});

/** Refuses a collaborator's HTTP read of a thread not shared with it live, failing closed. */
export const requireCollaboratorHttpThreadFork = Effect.fn("requireCollaboratorHttpThreadFork")(
  function* (threadId: string) {
    const { subject } = yield* EnvironmentAuthenticatedPrincipal;
    if (!isCollaboratorSubject(subject)) return;
    const shares = yield* Effect.serviceOption(CollaboratorSharesFork);
    if (Option.isSome(shares) && shares.value.isShared(subject, threadId)) return;
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  },
);
