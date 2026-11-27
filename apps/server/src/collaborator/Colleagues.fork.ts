// Fork-only (colleague-collab): saved colleagues. Accepting an invite leaves each server holding
// the other's collaborator grant, a bearer token kept in the secret store, so either side shares
// a thread with no link. The grant is the plain collaborator grant: `CollaboratorSession` fences it
// to the threads shared with its subject, plus read access to every team project thread.
import {
  COLLABORATOR_SCOPES,
  COLLEAGUE_FORGET_ROUTE_FORK,
  COLLEAGUE_PAIR_CLIENT_ROUTE_FORK,
  COLLEAGUE_THREAD_ROUTE_FORK,
  COLLEAGUE_THREADS_ROUTE_FORK,
  type ColleagueThreadInputFork,
  ColleagueThreadResultFork,
  type ColleagueThreadsInputFork,
  ColleagueThreadsResultFork,
  type AuthEnvironmentScope,
  type CollaboratorShareErrorFork,
  type CollaboratorThreadMissingErrorFork,
  ColleagueNoLiveShareErrorFork,
  ColleagueNoScopeErrorFork,
  ColleagueNotHttpErrorFork,
  ColleagueOwnGrantErrorFork,
  ColleaguePublicHttpErrorFork,
  type ColleagueClientPairingFork,
  type ColleagueConnectInputFork,
  type ColleagueErrorFork,
  type ColleagueFork,
  type ColleagueGrantFork,
  type ColleagueInviteInputFork,
  type ColleagueQueuedMessageFork,
  type ColleagueQueueMessageInputFork,
  ColleagueMissingErrorFork,
  ColleagueNotCollaboratorErrorFork,
  ColleagueRemoteErrorFork,
  ColleagueRevokedErrorFork,
  ColleagueSavedAsAnotherErrorFork,
  ColleagueSelfErrorFork,
  ColleagueSilentErrorFork,
  type ColleagueSaveInputFork,
  type ColleagueShareThreadInputFork,
  ColleagueStorageErrorFork,
  ColleagueUnknownShapeErrorFork,
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as CollaboratorShares from "./CollaboratorShares.fork.ts";
import { makeColleagueOutbox } from "./ColleagueOutbox.fork.ts";
import {
  collaboratorSessionLifetimeFork,
  collaboratorSubject,
  isCollaboratorSubject,
} from "./collaboratorSubject.fork.ts";

const CLIENT_PAIRING_TTL = Duration.minutes(5);
const REMOTE_TIMEOUT = Duration.seconds(10);

interface ColleagueRow {
  readonly subject: string;
  readonly name: string;
  readonly environment_id: string;
  readonly url: string;
  readonly secret_name: string;
  readonly saved_at: string;
  /** The session this server issued as the colleague's grant here; null if never known. */
  readonly grant_session_id: string | null;
  /** The collaborator session that saved them here through `save`; null for `connect`. */
  readonly saved_by_session_id: string | null;
}

const toColleague = (
  row: ColleagueRow,
  threadIds: ReadonlyMap<string, ReadonlyArray<ThreadId>>,
): ColleagueFork => ({
  subject: row.subject,
  name: row.name,
  environmentId: EnvironmentId.make(row.environment_id),
  url: row.url,
  savedAt: IsoDateTime.make(row.saved_at),
  threadIds: threadIds.get(row.subject) ?? [],
});

const ClientPairingResponse = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ColleagueClientPairingResponseFork = typeof ClientPairingResponse.Type;

/**
 * Only an http(s) origin receives a grant; plain http only where a share link already goes:
 * loopback, Tailscale, or the private network.
 */
const grantOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(new ColleagueNotHttpErrorFork());
  }
  const { hostname } = parsed;
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(hostname) &&
    !isTailnetHost(hostname) &&
    !isPrivateNetworkHost(hostname)
  ) {
    return Effect.fail(new ColleaguePublicHttpErrorFork({ origin: parsed.origin }));
  }
  return Effect.succeed(parsed.origin);
};

/** Their server refused a read, with its reason: the thread is not one this colleague may read. */
export class ColleagueReadRefusedErrorFork extends Schema.TaggedError<ColleagueReadRefusedErrorFork>()(
  "ColleagueReadRefusedErrorFork",
  { colleague: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `${this.colleague}'s server refused: ${this.reason}`;
  }
}

const RefusalBody = Schema.Struct({ error: Schema.String });

export class ColleaguesFork extends Context.Service<
  ColleaguesFork,
  {
    /** Accept step 1, owner: this server's grant for the sharer, under a subject of its own. */
    readonly invite: (
      input: ColleagueInviteInputFork,
    ) => Effect.Effect<ColleagueGrantFork, ColleagueErrorFork>;
    /** Accept step 2, called by a collaborator's session: keeps their grant, answers with ours. */
    readonly save: (
      caller: { readonly subject: string; readonly sessionId: AuthSessionId },
      input: ColleagueSaveInputFork,
    ) => Effect.Effect<ColleagueGrantFork, ColleagueErrorFork>;
    /** Accept step 3, owner: keeps the sharer's grant under step 1's subject. */
    readonly connect: (
      input: ColleagueConnectInputFork,
    ) => Effect.Effect<ColleagueFork, ColleagueErrorFork>;
    readonly list: Effect.Effect<ReadonlyArray<ColleagueFork>>;
    readonly changes: Stream.Stream<ReadonlyArray<ColleagueFork>>;
    /** Shares a thread with a saved colleague; their attached app shows it live. */
    readonly shareThread: (
      input: ColleagueShareThreadInputFork,
    ) => Effect.Effect<
      void,
      ColleagueErrorFork | CollaboratorShareErrorFork | CollaboratorThreadMissingErrorFork
    >;
    /** A one-time code for one of this owner's clients to attach the colleague's environment. */
    readonly pairClient: (
      subject: string,
    ) => Effect.Effect<ColleagueClientPairingFork, ColleagueErrorFork>;
    /** Drops the colleague here and asks their server to drop this side. */
    readonly remove: (
      subject: string,
    ) => Effect.Effect<{ readonly endedThere: boolean }, ColleagueErrorFork>;
    /** For a colleague's server: a one-time code for one of their clients, as their subject. */
    readonly issueClientPairing: (caller: {
      readonly subject: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<ColleagueClientPairingResponseFork, ColleagueErrorFork>;
    /** For a colleague's server that removed this side: forgets them here too. */
    readonly forget: (subject: string) => Effect.Effect<void, ColleagueErrorFork>;
    /** Messages waiting here for colleagues' threads, in send order. */
    readonly outbox: Stream.Stream<ReadonlyArray<ColleagueQueuedMessageFork>>;
    /** Keeps a message for a saved colleague's thread until a client delivers it. */
    readonly queueMessage: (
      input: ColleagueQueueMessageInputFork,
    ) => Effect.Effect<void, ColleagueErrorFork>;
    /** Removes a queued message: delivered, withdrawn, or taken back to edit. */
    readonly unqueueMessage: (id: string) => Effect.Effect<void, ColleagueErrorFork>;
    /** The threads a colleague's server lets this one read, as their grant here: read-only. */
    readonly threadsOf: (
      subject: string,
      input: ColleagueThreadsInputFork,
    ) => Effect.Effect<ColleagueThreadsResultFork, ColleagueErrorFork>;
    /** One of those threads; a thread outside them is refused with their reason. */
    readonly threadOf: (
      subject: string,
      input: ColleagueThreadInputFork,
    ) => Effect.Effect<
      ColleagueThreadResultFork,
      ColleagueErrorFork | ColleagueReadRefusedErrorFork
    >;
  }
>()("t3/collaborator/Colleagues.fork/ColleaguesFork") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const shares = yield* CollaboratorShares.CollaboratorSharesFork;
  const sessionChanges = (yield* SessionStore.SessionStore).streamChanges;
  const outbox = yield* makeColleagueOutbox;
  // Only the origin checked may receive a grant: a redirect could forward it anywhere.
  const httpClient = HttpClient.transform(yield* HttpClient.HttpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const readRows = sql<ColleagueRow>`
    SELECT subject, name, environment_id, url, secret_name, saved_at, grant_session_id,
      saved_by_session_id
    FROM fork_colleagues
    ORDER BY saved_at, subject
  `;
  const ref = yield* SubscriptionRef.make<ReadonlyArray<ColleagueRow>>(
    yield* readRows.pipe(Effect.orDie),
  );
  const reload = readRows.pipe(
    Effect.flatMap((rows) => SubscriptionRef.set(ref, rows)),
    Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })),
    Effect.andThen(shares.colleaguesChanged),
  );
  const rowOf = (subject: string) =>
    SubscriptionRef.get(ref).pipe(
      Effect.map((rows) => rows.find((row) => row.subject === subject)),
      Effect.filterOrFail(
        (row): row is ColleagueRow => row !== undefined,
        () => new ColleagueMissingErrorFork({ subject }),
      ),
    );

  // Saves, removals and the lapse sweep take turns, so a sweep never judges a half-saved row.
  const exclusive = (yield* Semaphore.make(1)).withPermits(1);
  // Saved colleagues with what is shared with each; either side changing re-emits.
  const changes = Stream.zipLatest(SubscriptionRef.changes(ref), shares.liveThreadIds).pipe(
    Stream.map(([rows, threadIds]) => rows.map((row) => toColleague(row, threadIds))),
  );
  const list = Stream.runHead(changes).pipe(Effect.map(Option.getOrElse(() => [])));

  const selfId = environment.getDescriptor.pipe(Effect.map((self) => self.environmentId));
  // The grant `invite` issued per sharer environment, until `connect` saves the row recording it.
  const invited = new Map<
    string,
    { readonly subject: string; readonly name: string; readonly sessionId: string }
  >();
  const revoke = Effect.fn("ColleaguesFork.revoke")(function* (
    sessionId: string | null | undefined,
  ) {
    if (sessionId) yield* auth.revokeSession(AuthSessionId.make(sessionId)).pipe(Effect.ignore);
  });

  const issueGrant = Effect.fn("ColleaguesFork.issueGrant")(function* (
    subject: string,
    name: string,
    linkBaseUrl: string | undefined,
  ) {
    const { base } = yield* shares.publicBaseUrl(linkBaseUrl);
    const issued = yield* auth
      .issueSession({
        subject,
        scopes: COLLABORATOR_SCOPES,
        label: `Colleague ${name}'s server`,
        ...collaboratorSessionLifetimeFork(subject),
      })
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    const grant: ColleagueGrantFork = {
      environmentId: yield* selfId,
      url: base,
      subject,
      token: Redacted.make(issued.token),
    };
    return { grant, sessionId: issued.sessionId };
  });

  /**
   * Keeps a colleague's grant; their token goes under a fresh secret name before the row names it.
   * A replaced row's secret goes, and so does the grant this server gave under it.
   */
  const store = Effect.fn("ColleaguesFork.store")(function* (
    subject: string,
    name: string,
    grant: ColleagueGrantFork,
    grantSessionId: string | null,
    savedBy: string | null,
  ) {
    if (grant.environmentId === (yield* selfId)) {
      return yield* new ColleagueOwnGrantErrorFork();
    }
    const rows = yield* SubscriptionRef.get(ref);
    if (rows.some((row) => row.environment_id === grant.environmentId && row.subject !== subject)) {
      return yield* new ColleagueSavedAsAnotherErrorFork();
    }
    const url = yield* grantOrigin(grant.url);
    const secretName = `colleague-${Hex.encode(yield* random.randomBytes(16).pipe(Effect.orDie))}`;
    yield* secrets
      .set(secretName, new TextEncoder().encode(Redacted.value(grant.token)))
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    const savedAt = DateTime.formatIso(yield* DateTime.now);
    const replaced = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const replaced = yield* sql<Pick<ColleagueRow, "secret_name" | "grant_session_id">>`
            DELETE FROM fork_colleagues
            WHERE subject = ${subject}
            RETURNING secret_name, grant_session_id
          `;
          yield* sql`
            INSERT INTO fork_colleagues
              (subject, name, environment_id, url, secret_name, saved_at, grant_session_id,
                saved_by_session_id)
            VALUES (${subject}, ${name}, ${grant.environmentId}, ${url}, ${secretName}, ${savedAt},
              ${grantSessionId}, ${savedBy})
          `;
          return replaced;
        }),
      )
      .pipe(
        Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })),
        Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)),
      );
    yield* Effect.forEach(replaced, (row) =>
      Effect.andThen(
        secrets.remove(row.secret_name).pipe(Effect.ignore),
        row.grant_session_id === grantSessionId ? Effect.void : revoke(row.grant_session_id),
      ),
    );
    yield* reload;
    const saved = (yield* list).find((colleague) => colleague.subject === subject);
    return saved ?? (yield* new ColleagueMissingErrorFork({ subject }));
  });

  const invite: ColleaguesFork["Service"]["invite"] = Effect.fn("ColleaguesFork.invite")(function* (
    input,
  ) {
    if (input.environmentId === (yield* selfId)) {
      return yield* new ColleagueSelfErrorFork();
    }
    const rows = yield* SubscriptionRef.get(ref);
    const saved = rows.find((row) => row.environment_id === input.environmentId);
    const pending = invited.get(input.environmentId);
    const subject =
      saved?.subject ?? pending?.subject ?? (yield* freshSubject(input.name, input.environmentId));
    const { grant, sessionId } = yield* issueGrant(subject, input.name, input.linkBaseUrl);
    yield* revoke(pending?.sessionId);
    invited.set(input.environmentId, { subject, name: input.name, sessionId });
    return grant;
  }, exclusive);

  /**
   * A new colleague takes their name's subject only while nothing here uses it: a one-time guest
   * or another colleague of that name keeps their shares, and this one gets a suffix nobody holds.
   * Runs under `exclusive`, so two invites never pick the same subject.
   */
  const freshSubject = Effect.fn("ColleaguesFork.freshSubject")(function* (
    name: string,
    environmentId: string,
  ) {
    const named = collaboratorSubject(name);
    const rows = yield* SubscriptionRef.get(ref);
    const sessions = yield* auth
      .listSessions()
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    const links = yield* auth
      .listPairingLinks()
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    const taken = new Set([
      ...rows.map((row) => row.subject),
      ...sessions.map((session) => session.subject),
      ...links.map((link) => link.subject),
      ...[...invited.values()].map((invite) => invite.subject),
    ]);
    const suffixed = `${named}-${environmentId.slice(0, 8).toLowerCase()}`;
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? named : n === 2 ? suffixed : `${suffixed}-${n - 1}`;
      if (!taken.has(candidate) && shares.nameOf(candidate) === undefined) return candidate;
    }
  });

  const save: ColleaguesFork["Service"]["save"] = Effect.fn("ColleaguesFork.save")(function* (
    { subject, sessionId: caller },
    input,
  ) {
    const name =
      isCollaboratorSubject(subject) && shares.sharesLive(subject)
        ? shares.nameOf(subject)
        : undefined;
    if (name === undefined) {
      return yield* new ColleagueNoLiveShareErrorFork();
    }
    const { grant, sessionId } = yield* issueGrant(subject, name, input.linkBaseUrl);
    yield* store(subject, name, input.grant, sessionId, caller).pipe(
      Effect.onError(() => revoke(sessionId)),
    );
    return grant;
  }, exclusive);

  const connect: ColleaguesFork["Service"]["connect"] = Effect.fn("ColleaguesFork.connect")(
    function* (input) {
      if (!isCollaboratorSubject(input.subject)) {
        return yield* new ColleagueNotCollaboratorErrorFork();
      }
      const pending = invited.get(input.grant.environmentId);
      const sessionId = pending?.subject === input.subject ? pending.sessionId : null;
      const colleague = yield* store(input.subject, input.name, input.grant, sessionId, null);
      invited.delete(input.grant.environmentId);
      return colleague;
    },
    exclusive,
  );

  const tokenOf = Effect.fn("ColleaguesFork.tokenOf")(function* (row: ColleagueRow) {
    const stored = yield* secrets
      .get(row.secret_name)
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    if (Option.isNone(stored)) {
      return yield* new ColleagueStorageErrorFork({ cause: `missing secret ${row.secret_name}` });
    }
    return new TextDecoder().decode(stored.value);
  });

  const decodeFrom =
    <A>(row: ColleagueRow, schema: Schema.Codec<A, unknown>) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(
          (cause) => new ColleagueUnknownShapeErrorFork({ colleague: row.name, cause }),
        ),
      );

  /** Posts to the colleague's server with its grant; silence fails here, any answer returns. */
  const postRemote = Effect.fn("ColleaguesFork.postRemote")(function* (
    row: ColleagueRow,
    route: string,
    body?: object,
  ) {
    const token = yield* tokenOf(row);
    const request = HttpClientRequest.post(`${row.url}${route}`).pipe(
      HttpClientRequest.bearerToken(token),
    );
    return yield* httpClient
      .execute(body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body))
      .pipe(
        Effect.timeout(REMOTE_TIMEOUT),
        Effect.mapError((cause) => new ColleagueSilentErrorFork({ colleague: row.name, cause })),
      );
  });

  const answered =
    (row: ColleagueRow) =>
    (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      ColleagueRevokedErrorFork | ColleagueRemoteErrorFork
    > => {
      const { status } = response;
      if (status < 300) return Effect.succeed(response);
      return Effect.fail(
        status === 401 || status === 403
          ? new ColleagueRevokedErrorFork({ colleague: row.name })
          : new ColleagueRemoteErrorFork({ colleague: row.name, status }),
      );
    };

  /** Their refusal and silence fail apart. */
  const callRemote = (row: ColleagueRow, route: string, body?: object) =>
    postRemote(row, route, body).pipe(Effect.flatMap(answered(row)));

  const pairClient: ColleaguesFork["Service"]["pairClient"] = Effect.fn(
    "ColleaguesFork.pairClient",
  )(function* (subject) {
    const row = yield* rowOf(subject);
    const response = yield* callRemote(row, COLLEAGUE_PAIR_CLIENT_ROUTE_FORK);
    const pairing = yield* HttpClientResponse.schemaBodyJson(ClientPairingResponse)(response).pipe(
      Effect.mapError(
        (cause) => new ColleagueUnknownShapeErrorFork({ colleague: row.name, cause }),
      ),
    );
    return { environmentId: EnvironmentId.make(row.environment_id), url: row.url, ...pairing };
  });

  /** Ends everything the subject holds here: live shares, sessions, links, and the saved row. */
  const forgetHere = Effect.fn("ColleaguesFork.forgetHere")(function* (row: ColleagueRow) {
    yield* shares
      .unshareAll(row.subject)
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    const sessions = yield* auth
      .listSessions()
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    yield* Effect.forEach(
      sessions.filter((session) => session.subject === row.subject),
      (session) =>
        auth
          .revokeSession(session.sessionId)
          .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause }))),
    );
    const links = yield* auth
      .listPairingLinks()
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    yield* Effect.forEach(
      links.filter((link) => link.subject === row.subject),
      (link) =>
        auth
          .revokePairingLink(link.id)
          .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause }))),
    );
    yield* sql`DELETE FROM fork_colleagues WHERE subject = ${row.subject}`.pipe(
      Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })),
    );
    yield* secrets.remove(row.secret_name).pipe(Effect.ignore);
    yield* outbox.drop(row.environment_id);
    yield* reload;
  });

  const remove: ColleaguesFork["Service"]["remove"] = Effect.fn("ColleaguesFork.remove")(
    function* (subject) {
      const row = yield* rowOf(subject);
      // Asked first, while this side's grant there still works.
      const endedThere = yield* callRemote(row, COLLEAGUE_FORGET_ROUTE_FORK).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      yield* exclusive(forgetHere(row));
      return { endedThere };
    },
  );

  /**
   * Revoking the grant given here, or the collaborator session that saved them, forgets the
   * colleague: every session, link and share their subject holds here ends with the row.
   * Callers hold `exclusive`.
   */
  const forgetLapsed = Effect.fn("ColleaguesFork.forgetLapsed")(function* () {
    const sessions = yield* auth
      .listSessions()
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    const live = new Set<string>(sessions.map((session) => session.sessionId));
    const rows = yield* readRows.pipe(
      Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })),
    );
    const lapsed = rows.filter((row) =>
      [row.grant_session_id, row.saved_by_session_id].some((id) => id !== null && !live.has(id)),
    );
    yield* Effect.forEach(lapsed, forgetHere);
  });
  yield* sessionChanges.pipe(
    Stream.filter((change) => change.type === "clientRemoved"),
    Stream.runForEach(() => exclusive(forgetLapsed()).pipe(Effect.ignore)),
    Effect.forkScoped({ startImmediately: true }),
  );

  // Under `exclusive`, so a removal never lands between the eligibility check and the new code.
  const issueClientPairing: ColleaguesFork["Service"]["issueClientPairing"] = Effect.fn(
    "ColleaguesFork.issueClientPairing",
  )(function* ({ subject, scopes: held }) {
    // Also run here: a session can end without an announcement, as when it lapses while down.
    yield* forgetLapsed();
    // The sharer's app attaches as soon as its server saved us, which can beat our `connect`.
    const pending = [...invited.values()].find((invite) => invite.subject === subject);
    const name = pending?.name ?? (yield* rowOf(subject)).name;
    // Never wider than the grant the colleague's server called with.
    const scopes = COLLABORATOR_SCOPES.filter((scope) => held.includes(scope));
    if (scopes.length === 0) return yield* new ColleagueNoScopeErrorFork();
    const issued = yield* auth
      .createPairingLink({ subject, label: `Colleague ${name}`, scopes, ttl: CLIENT_PAIRING_TTL })
      .pipe(Effect.mapError((cause) => new ColleagueStorageErrorFork({ cause })));
    return {
      credential: TrimmedNonEmptyString.make(issued.credential),
      expiresAt: IsoDateTime.make(DateTime.formatIso(issued.expiresAt)),
    };
  }, exclusive);

  const forget: ColleaguesFork["Service"]["forget"] = Effect.fn("ColleaguesFork.forget")(function* (
    subject,
  ) {
    yield* forgetHere(yield* rowOf(subject));
  }, exclusive);

  const threadsOf: ColleaguesFork["Service"]["threadsOf"] = Effect.fn("ColleaguesFork.threadsOf")(
    function* (subject, input) {
      const row = yield* rowOf(subject);
      const response = yield* callRemote(row, COLLEAGUE_THREADS_ROUTE_FORK, input);
      return yield* decodeFrom(row, ColleagueThreadsResultFork)(response);
    },
  );

  const threadOf: ColleaguesFork["Service"]["threadOf"] = Effect.fn("ColleaguesFork.threadOf")(
    function* (subject, input) {
      const row = yield* rowOf(subject);
      const response = yield* postRemote(row, COLLEAGUE_THREAD_ROUTE_FORK, input);
      // A thread they may not read comes back with their reason.
      if (response.status === 404) {
        const { error: reason } = yield* decodeFrom(row, RefusalBody)(response);
        return yield* new ColleagueReadRefusedErrorFork({ colleague: row.name, reason });
      }
      yield* answered(row)(response);
      return yield* decodeFrom(row, ColleagueThreadResultFork)(response);
    },
  );

  const shareThread: ColleaguesFork["Service"]["shareThread"] = Effect.fn(
    "ColleaguesFork.shareThread",
  )(function* (input) {
    const row = yield* rowOf(input.subject);
    yield* shares.shareWith({
      threadId: input.threadId,
      subject: row.subject,
      name: shares.nameOf(row.subject) ?? row.name,
      access: input.access,
    });
  });

  const queueMessage: ColleaguesFork["Service"]["queueMessage"] = Effect.fn(
    "ColleaguesFork.queueMessage",
  )(function* (input) {
    const rows = yield* SubscriptionRef.get(ref);
    if (!rows.some((row) => row.environment_id === input.environmentId)) {
      return yield* new ColleagueMissingErrorFork({ subject: input.environmentId });
    }
    yield* outbox.queue(input);
  }, exclusive);

  return ColleaguesFork.of({
    outbox: outbox.changes,
    queueMessage,
    unqueueMessage: outbox.unqueue,
    invite,
    save,
    connect,
    list,
    changes,
    shareThread,
    pairClient,
    remove,
    issueClientPairing,
    forget,
    threadsOf,
    threadOf,
  });
});

/** Carries the share service, which it builds on, so the server provides both from one place. */
export const layer = Layer.effect(ColleaguesFork, make).pipe(
  Layer.provideMerge(CollaboratorShares.layer.pipe(Layer.provide(CommandReceiptStore.layer))),
);
