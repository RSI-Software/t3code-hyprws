// Fork-only (colleague-collab): share one thread with a collaborator through a pairing link.
// Each session's RPCs adapt to these shares in `CollaboratorSession.fork.ts`; a saved colleague
// also reads every team project thread there.
// Unsharing freezes their copy; `approve` access holds messages in `CollaboratorMessages.fork.ts`.
import {
  AuthOrchestrationReadScope,
  COLLABORATOR_SCOPES,
  COLLABORATOR_THREAD_LINK_PARAM,
  CollaboratorAccessFork,
  CollaboratorAccessErrorFork,
  type CollaboratorSetAccessInputFork,
  CollaboratorShareErrorFork,
  type CollaboratorShareThreadInputFork,
  type CollaboratorShareThreadResultFork,
  CollaboratorThreadMissingErrorFork,
  type CollaboratorThreadSharesResultFork,
  CollaboratorUnshareErrorFork,
  type CollaboratorUnshareThreadInputFork,
  EnvironmentAuthenticatedPrincipal,
  type EnvironmentAuthorizationError,
  type OrchestrationV2DispatchCommandError,
  OrchestrationV2ThreadShell,
  type RpcScopeAuthorization,
  ThreadId,
} from "@t3tools/contracts";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import {
  type CollaboratorHandlersFork,
  type CollaboratorMessageHandlersFork,
  type CollaboratorTypingHandlersFork,
  makeCollaboratorSession,
} from "./CollaboratorSession.fork.ts";
import { collaboratorSubject, isCollaboratorSubject } from "./collaboratorSubject.fork.ts";
import { discoverTunnelOrigin } from "./tunnelOrigin.fork.ts";

const SHARE_LINK_TTL = Duration.hours(24);

export interface CollaboratorShare {
  readonly name: string;
  /** Live shares, each with what the collaborator's messages may do. */
  readonly threadIds: ReadonlyMap<string, CollaboratorAccessFork>;
  /** Stopped shares: the thread's shell as it was when sharing stopped. */
  readonly frozen: ReadonlyMap<string, OrchestrationV2ThreadShell>;
  /** Each thread's share, live or stopped, by when it was first made: who joined a thread first. */
  readonly since: ReadonlyMap<string, number>;
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
  for (const [index, row] of rows.entries()) {
    const prior = shares.get(row.subject);
    const threadIds = new Map(prior?.threadIds);
    const frozen = new Map(prior?.frozen);
    const since = new Map(prior?.since).set(row.thread_id, index);
    if (row.frozen_shell_json === null) {
      threadIds.set(row.thread_id, isAccess(row.access) ? row.access : "approve");
    } else {
      const shell = decodeFrozenShell(row.frozen_shell_json);
      if (Option.isSome(shell)) frozen.set(row.thread_id, shell.value);
    }
    // The first name sticks: "alex" typed later reaches the same person, who stays "Alex".
    shares.set(row.subject, { name: prior?.name ?? row.colleague_name, threadIds, frozen, since });
  }
  return shares;
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
    /** Shares with a known subject, such as a saved colleague's, minting no link. */
    readonly shareWith: (input: {
      readonly threadId: string;
      readonly subject: string;
      readonly name: string;
      readonly access?: CollaboratorAccessFork | undefined;
    }) => Effect.Effect<void, CollaboratorShareErrorFork | CollaboratorThreadMissingErrorFork>;
    /** Stops every live share with the subject, as `unshare` does one. */
    readonly unshareAll: (subject: string) => Effect.Effect<void, CollaboratorUnshareErrorFork>;
    /** The collaborator's name, from their first share; undefined when nothing was shared. */
    readonly nameOf: (subject: string) => string | undefined;
    /** Whether any thread is shared live with the subject. */
    readonly sharesLive: (subject: string) => boolean;
    /** The origin other machines reach this server on, as for a share link. */
    readonly publicBaseUrl: (
      linkBaseUrl: string | undefined,
    ) => Effect.Effect<{ readonly base: string; readonly localOnly: boolean }>;
    readonly threadShares: (threadId: string) => Effect.Effect<CollaboratorThreadSharesResultFork>;
    readonly unshare: (
      input: CollaboratorUnshareThreadInputFork,
    ) => Effect.Effect<void, CollaboratorUnshareErrorFork>;
    readonly setAccess: (
      input: CollaboratorSetAccessInputFork,
    ) => Effect.Effect<void, CollaboratorAccessErrorFork>;
    /** Whether the thread is shared live with the subject. */
    readonly isShared: (subject: string, threadId: string) => boolean;
    /**
     * The one read check for a collaborator subject: shared live, or a saved colleague's view of
     * a team project's thread, which is read-only.
     */
    readonly canRead: (subject: string, threadId: string) => Effect.Effect<boolean>;
    /** Rechecks team access after a colleague is saved or forgotten. */
    readonly colleaguesChanged: Effect.Effect<void>;
    /** Each subject's live shared threads, now and on every change. */
    readonly liveThreadIds: Stream.Stream<ReadonlyMap<string, ReadonlyArray<ThreadId>>>;
    /** The waiting-message handlers for `subject`, or the host's for `null`. */
    readonly messageHandlers: (subject: string | null) => CollaboratorMessageHandlersFork;
    /** The typing handlers for `subject`, or the host's for `null`. */
    readonly typingHandlers: (subject: string | null) => CollaboratorTypingHandlersFork;
    /**
     * Wraps the session's RPC authorization: a collaborator session is also refused outside its
     * closed set; other sessions pass through.
     */
    readonly guardRpc: (
      subject: string,
    ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | RpcScopeAuthorization>;
    /**
     * Narrows a collaborator session's thread handlers and answers its waiting messages; other
     * sessions only lose the right to attribute a message to a collaborator.
     */
    readonly wrapHandlers: <A, E, R, SE, SR, TE, TR, LA, LE, LR, OE, OR, AE, AR>(
      subject: string,
      handlers: CollaboratorHandlersFork<A, E, R, SE, SR, TE, TR, LA, LE, LR, OE, OR, AE, AR>,
    ) => CollaboratorHandlersFork<
      A,
      E | EnvironmentAuthorizationError | OrchestrationV2DispatchCommandError,
      R,
      SE,
      SR,
      TE | EnvironmentAuthorizationError,
      TR,
      LA,
      LE,
      LR,
      OE,
      OR,
      AE,
      AR
    > &
      Partial<CollaboratorMessageHandlersFork & CollaboratorTypingHandlersFork>;
  }
>()("t3/collaborator/CollaboratorShares.fork/CollaboratorSharesFork") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const httpClient = yield* HttpClient.HttpClient;
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
        platform,
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

  const isShared = (subject: string, threadId: string) =>
    current.get(subject)?.threadIds.has(threadId) === true;

  const session = yield* makeCollaboratorSession({
    current: () => current,
    changes: SubscriptionRef.changes(ref),
    isShared,
  });

  const readThread = Effect.fn("CollaboratorSharesFork.readThread")(function* (threadId: ThreadId) {
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
    return thread;
  });

  const record = Effect.fn("CollaboratorSharesFork.record")(function* (
    threadId: ThreadId,
    subject: string,
    name: string,
    access: CollaboratorAccessFork | null,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_colleague_shares (subject, thread_id, colleague_name, created_at, access)
      VALUES (${subject}, ${threadId}, ${name}, ${createdAt}, ${access ?? "approve"})
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
  });

  const share = Effect.fn("CollaboratorSharesFork.share")(function* (
    input: CollaboratorShareThreadInputFork,
  ) {
    const { threadId } = input;
    const thread = yield* readThread(threadId);
    const subject = collaboratorSubject(input.collaboratorName);
    // A known colleague keeps their saved spelling, however the host typed it this time.
    const collaboratorName = current.get(subject)?.name ?? input.collaboratorName;
    const knownCollaborator = yield* auth.listSessions().pipe(
      Effect.map((sessions) => sessions.some((session) => session.subject === subject)),
      Effect.orElseSucceed(() => false),
    );
    // Minted first so a failure grants nothing; a paired collaborator may still need it for a new device.
    const issued = yield* auth
      .createPairingLink({
        subject,
        label: `Collaborator ${collaboratorName}`,
        scopes: COLLABORATOR_SCOPES,
        ttl: SHARE_LINK_TTL,
      })
      .pipe(
        Effect.mapError(
          (cause) => new CollaboratorShareErrorFork({ operation: "pair", threadId, cause }),
        ),
      );
    yield* record(thread.id, subject, collaboratorName, input.access ?? null);
    // Pairing ignores the query, so the thread rides inside the pairing URL to the collaborator's app.
    const { base, localOnly } = yield* pairingBaseUrl(input.linkBaseUrl);
    const pairing = new URL(buildPairingUrl(base, issued.credential));
    pairing.searchParams.set(COLLABORATOR_THREAD_LINK_PARAM, thread.id);
    return { pairingUrl: pairing.toString(), localOnly, knownCollaborator, collaboratorName };
  });

  const shareWith: CollaboratorSharesFork["Service"]["shareWith"] = Effect.fn(
    "CollaboratorSharesFork.shareWith",
  )(function* (input) {
    const thread = yield* readThread(ThreadId.make(input.threadId));
    yield* record(thread.id, input.subject, input.name, input.access ?? null);
  });

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
    yield* session.endShare(
      subject,
      threadId,
      Effect.gen(function* () {
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

  const unshareAll = Effect.fn("CollaboratorSharesFork.unshareAll")(function* (subject: string) {
    for (const threadId of current.get(subject)?.threadIds.keys() ?? []) {
      yield* unshare({ subject, threadId: ThreadId.make(threadId) });
    }
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

  return CollaboratorSharesFork.of({
    share,
    shareWith,
    unshareAll,
    nameOf: (subject) => current.get(subject)?.name,
    sharesLive: (subject) => (current.get(subject)?.threadIds.size ?? 0) > 0,
    publicBaseUrl: pairingBaseUrl,
    threadShares,
    unshare,
    setAccess,
    isShared,
    liveThreadIds: SubscriptionRef.changes(ref).pipe(
      Stream.map(
        (shares) =>
          new Map(
            [...shares].map(([subject, { threadIds }]) => [
              subject,
              [...threadIds.keys()].map((id) => ThreadId.make(id)),
            ]),
          ),
      ),
    ),
    ...session.handlers,
  });
});

export const layer = Layer.effect(CollaboratorSharesFork, make);

/** Refuses a collaborator's HTTP read of a thread it cannot read, failing closed. */
export const requireCollaboratorHttpThreadFork = Effect.fn("requireCollaboratorHttpThreadFork")(
  function* (threadId: string) {
    const { subject } = yield* EnvironmentAuthenticatedPrincipal;
    if (!isCollaboratorSubject(subject)) return;
    const shares = yield* Effect.serviceOption(CollaboratorSharesFork);
    if (Option.isSome(shares) && (yield* shares.value.canRead(subject, threadId))) return;
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  },
);
