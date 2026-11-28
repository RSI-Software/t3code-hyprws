// Fork-only (colleague-collab): share one thread with a collaborator through a pairing link.
// It saves a colleague only when it also carries a colleague invite, which the host opts into.
// Sessions adapt to these shares in `CollaboratorSession.fork.ts`. Unsharing freezes their copy;
// `approve` access holds messages in `CollaboratorMessages.fork.ts`.
import {
  AuthOrchestrationReadScope,
  COLLABORATOR_SCOPES,
  COLLABORATOR_THREAD_LINK_PARAM,
  COLLEAGUE_INVITE_LINK_PARAM,
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
  type ColleagueInviteLinkInputFork,
  type ColleagueInviteLinkResultFork,
  ColleagueStorageErrorFork,
  EnvironmentAuthenticatedPrincipal,
  type EnvironmentAuthorizationError,
  type OrchestrationV2DispatchCommandError,
  OrchestrationV2ThreadShell,
  type RpcScopeAuthorization,
  ThreadId,
} from "@t3tools/contracts";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
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
    // The first name sticks, so a person keeps the spelling they were first shared under.
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
    /** Settings → Invite colleague: a link with a colleague invite and no thread. */
    readonly inviteColleague: (
      input: ColleagueInviteLinkInputFork,
    ) => Effect.Effect<ColleagueInviteLinkResultFork, CollaboratorShareErrorFork>;
    /** The invited name, while the subject's unexpired, unspent invite has this token. */
    readonly colleagueInvite: (
      subject: string,
      token: string,
    ) => Effect.Effect<string | undefined, ColleagueStorageErrorFork>;
    readonly spendColleagueInvite: (
      token: string,
    ) => Effect.Effect<void, ColleagueStorageErrorFork>;
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
    /** This server's owner, as they named themselves to git; undefined when unset. */
    readonly hostName: Effect.Effect<string | undefined>;
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
     * a team project's thread, whose messages wait for the host.
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
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const httpClient = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  // The table keeps only a digest, so a database read cannot spend an invite.
  const inviteDigest = Effect.fn("CollaboratorSharesFork.inviteDigest")(function* (token: string) {
    return Base64Url.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(token)));
  });
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

  /**
   * A pairing link for the subject. Pairing ignores the query, so the thread and the colleague
   * invite ride inside the pairing URL to the collaborator's app.
   */
  const mintLink = Effect.fn("CollaboratorSharesFork.mintLink")(function* (input: {
    readonly subject: string;
    readonly name: string;
    readonly linkBaseUrl: string | undefined;
    readonly threadId?: ThreadId;
    readonly colleague: boolean;
  }) {
    const { subject, name, threadId } = input;
    const fail = (cause: unknown) =>
      new CollaboratorShareErrorFork({ operation: "pair", ...(threadId && { threadId }), cause });
    const issued = yield* auth
      .createPairingLink({
        subject,
        label: `Collaborator ${name}`,
        scopes: COLLABORATOR_SCOPES,
        ttl: SHARE_LINK_TTL,
      })
      .pipe(Effect.mapError(fail));
    const { base, localOnly } = yield* pairingBaseUrl(input.linkBaseUrl);
    const pairing = new URL(buildPairingUrl(base, issued.credential));
    if (threadId) pairing.searchParams.set(COLLABORATOR_THREAD_LINK_PARAM, threadId);
    if (input.colleague) {
      const token = Base64Url.encode(yield* random.randomBytes(24).pipe(Effect.mapError(fail)));
      const tokenHash = yield* inviteDigest(token).pipe(Effect.mapError(fail));
      const now = yield* DateTime.now;
      const expiresAt = DateTime.formatIso(DateTime.addDuration(now, SHARE_LINK_TTL));
      yield* sql`DELETE FROM fork_colleague_invites WHERE expires_at <= ${DateTime.formatIso(now)}`.pipe(
        Effect.andThen(
          sql`
            INSERT INTO fork_colleague_invites (token_hash, subject, name, expires_at)
            VALUES (${tokenHash}, ${subject}, ${name}, ${expiresAt})
          `,
        ),
        Effect.mapError(fail),
      );
      pairing.searchParams.set(COLLEAGUE_INVITE_LINK_PARAM, token);
    }
    return { pairingUrl: pairing.toString(), localOnly };
  });

  // A typed name is always a new person, so it never reaches someone else's grant.
  const newPersonSubject = Effect.fn("CollaboratorSharesFork.newPersonSubject")(function* (
    name: string,
  ) {
    return `${collaboratorSubject(name)}-${yield* random.uuidV4()}`;
  });

  const share = Effect.fn("CollaboratorSharesFork.share")(function* (
    input: CollaboratorShareThreadInputFork,
  ) {
    const thread = yield* readThread(input.threadId);
    // Only a pick of someone shared before reaches their grant.
    const picked =
      input.subject !== undefined && current.has(input.subject) ? input.subject : undefined;
    const subject = picked ?? (yield* newPersonSubject(input.collaboratorName));
    const collaboratorName = current.get(subject)?.name ?? input.collaboratorName;
    const knownCollaborator = yield* auth.listSessions().pipe(
      Effect.map((sessions) => sessions.some((session) => session.subject === subject)),
      Effect.orElseSucceed(() => false),
    );
    // Minted first so a failure grants nothing; a paired collaborator may still need it for a new device.
    const link = yield* mintLink({
      subject,
      name: collaboratorName,
      linkBaseUrl: input.linkBaseUrl,
      threadId: thread.id,
      colleague: input.colleague === true,
    });
    yield* record(thread.id, subject, collaboratorName, input.access ?? null);
    return { ...link, knownCollaborator, collaboratorName };
  });

  const inviteColleague: CollaboratorSharesFork["Service"]["inviteColleague"] = Effect.fn(
    "CollaboratorSharesFork.inviteColleague",
  )(function* (input) {
    return yield* mintLink({
      subject: yield* newPersonSubject(input.name),
      name: input.name,
      linkBaseUrl: input.linkBaseUrl,
      colleague: true,
    });
  });

  const colleagueInvite: CollaboratorSharesFork["Service"]["colleagueInvite"] = Effect.fn(
    "CollaboratorSharesFork.colleagueInvite",
  )(
    function* (subject, token) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const tokenHash = yield* inviteDigest(token);
      const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM fork_colleague_invites
      WHERE token_hash = ${tokenHash} AND subject = ${subject} AND expires_at > ${now}
    `;
      return rows[0]?.name;
    },
    Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })),
  );

  const spendColleagueInvite: CollaboratorSharesFork["Service"]["spendColleagueInvite"] = Effect.fn(
    "CollaboratorSharesFork.spendColleagueInvite",
  )(
    function* (token) {
      const tokenHash = yield* inviteDigest(token);
      yield* sql`DELETE FROM fork_colleague_invites WHERE token_hash = ${tokenHash}`;
    },
    Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })),
  );

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
    inviteColleague,
    colleagueInvite,
    spendColleagueInvite,
    shareWith,
    unshareAll,
    nameOf: (subject) => current.get(subject)?.name,
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
