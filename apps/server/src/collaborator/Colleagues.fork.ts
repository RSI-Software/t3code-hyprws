// Fork-only (colleague-collab): saved colleagues. Accepting an invite leaves each server holding
// the other's collaborator grant, a bearer token kept in the secret store, so either side shares
// a thread with no link. The grant is the plain collaborator grant: `CollaboratorShares` fences it
// to the threads shared with its subject, so a saved colleague sees nothing until a share.
import {
  COLLABORATOR_SCOPES,
  COLLEAGUE_FORGET_ROUTE_FORK,
  COLLEAGUE_PAIR_CLIENT_ROUTE_FORK,
  type CollaboratorShareErrorFork,
  type CollaboratorThreadMissingErrorFork,
  type ColleagueClientPairingFork,
  type ColleagueConnectInputFork,
  ColleagueErrorFork,
  type ColleagueFork,
  type ColleagueGrantFork,
  type ColleagueInviteInputFork,
  type ColleagueSaveInputFork,
  type ColleagueShareThreadInputFork,
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
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
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CollaboratorShares from "./CollaboratorShares.fork.ts";
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
}

const toColleague = (row: ColleagueRow): ColleagueFork => ({
  subject: row.subject,
  name: row.name,
  environmentId: EnvironmentId.make(row.environment_id),
  url: row.url,
  savedAt: IsoDateTime.make(row.saved_at),
});

const ClientPairingResponse = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ColleagueClientPairingResponseFork = typeof ClientPairingResponse.Type;

const fail = (reason: ColleagueErrorFork["reason"], message: string) => (cause?: unknown) =>
  new ColleagueErrorFork({ reason, message, ...(cause === undefined ? {} : { cause }) });
const storageError = fail("storage", "Could not read or save colleagues.");
const missing = fail("missing", "That colleague is not saved here.");

/**
 * Only an http(s) origin receives a grant; plain http only where a share link already goes:
 * loopback, Tailscale, or the private network.
 */
const grantOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(fail("invalid", "Their address is not an http or https address.")());
  }
  const { hostname } = parsed;
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(hostname) &&
    !isTailnetHost(hostname) &&
    !isPrivateNetworkHost(hostname)
  ) {
    return Effect.fail(fail("invalid", `${parsed.origin} is public plain http.`)());
  }
  return Effect.succeed(parsed.origin);
};

export class ColleaguesFork extends Context.Service<
  ColleaguesFork,
  {
    /** Accept step 1, owner: this server's grant for the sharer, under a subject of its own. */
    readonly invite: (
      input: ColleagueInviteInputFork,
    ) => Effect.Effect<ColleagueGrantFork, ColleagueErrorFork>;
    /** Accept step 2, called by the collaborator `subject`: keeps their grant, answers with ours. */
    readonly save: (
      subject: string,
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
    readonly issueClientPairing: (
      subject: string,
    ) => Effect.Effect<ColleagueClientPairingResponseFork, ColleagueErrorFork>;
    /** For a colleague's server that removed this side: forgets them here too. */
    readonly forget: (subject: string) => Effect.Effect<void, ColleagueErrorFork>;
  }
>()("t3/collaborator/Colleagues.fork/ColleaguesFork") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const shares = yield* CollaboratorShares.CollaboratorSharesFork;
  // Only the origin checked may receive a grant: a redirect could forward it anywhere.
  const httpClient = HttpClient.transform(yield* HttpClient.HttpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const readRows = sql<ColleagueRow>`
    SELECT subject, name, environment_id, url, secret_name, saved_at, grant_session_id
    FROM fork_colleagues
    ORDER BY saved_at, subject
  `;
  const ref = yield* SubscriptionRef.make<ReadonlyArray<ColleagueRow>>(
    yield* readRows.pipe(Effect.orDie),
  );
  const reload = readRows.pipe(
    Effect.flatMap((rows) => SubscriptionRef.set(ref, rows)),
    Effect.mapError(storageError),
  );
  const rowOf = (subject: string) =>
    SubscriptionRef.get(ref).pipe(
      Effect.map((rows) => rows.find((row) => row.subject === subject)),
      Effect.filterOrFail(
        (row): row is ColleagueRow => row !== undefined,
        () => missing(),
      ),
    );

  const selfId = environment.getDescriptor.pipe(Effect.map((self) => self.environmentId));
  // The grant `invite` issued per sharer environment, until `connect` saves the row recording it.
  const invited = new Map<
    string,
    { readonly subject: string; readonly name: string; readonly sessionId: string }
  >();
  const revoke = (sessionId: string | null | undefined) =>
    sessionId ? auth.revokeSession(AuthSessionId.make(sessionId)).pipe(Effect.ignore) : Effect.void;

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
      .pipe(Effect.mapError(storageError));
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
  ) {
    if (grant.environmentId === (yield* selfId)) {
      return yield* fail("invalid", "That grant is from this environment.")();
    }
    const url = yield* grantOrigin(grant.url);
    const secretName = `colleague-${Hex.encode(yield* random.randomBytes(16).pipe(Effect.orDie))}`;
    yield* secrets
      .set(secretName, new TextEncoder().encode(Redacted.value(grant.token)))
      .pipe(Effect.mapError(storageError));
    const savedAt = DateTime.formatIso(yield* DateTime.now);
    // One row per environment: saving it again under another subject replaces the old row.
    const replaced = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const replaced = yield* sql<Pick<ColleagueRow, "secret_name" | "grant_session_id">>`
            DELETE FROM fork_colleagues
            WHERE subject = ${subject} OR environment_id = ${grant.environmentId}
            RETURNING secret_name, grant_session_id
          `;
          yield* sql`
            INSERT INTO fork_colleagues
              (subject, name, environment_id, url, secret_name, saved_at, grant_session_id)
            VALUES (${subject}, ${name}, ${grant.environmentId}, ${url}, ${secretName}, ${savedAt},
              ${grantSessionId})
          `;
          return replaced;
        }),
      )
      .pipe(
        Effect.mapError(storageError),
        Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)),
      );
    yield* Effect.forEach(replaced, (row) =>
      Effect.andThen(
        secrets.remove(row.secret_name).pipe(Effect.ignore),
        row.grant_session_id === grantSessionId ? Effect.void : revoke(row.grant_session_id),
      ),
    );
    yield* reload;
    return toColleague({
      subject,
      name,
      environment_id: grant.environmentId,
      url,
      secret_name: secretName,
      saved_at: savedAt,
      grant_session_id: grantSessionId,
    });
  });

  const invite: ColleaguesFork["Service"]["invite"] = Effect.fn("ColleaguesFork.invite")(
    function* (input) {
      if (input.environmentId === (yield* selfId)) {
        return yield* fail("invalid", "That is this environment.")();
      }
      const rows = yield* SubscriptionRef.get(ref);
      const saved = rows.find((row) => row.environment_id === input.environmentId);
      const pending = invited.get(input.environmentId);
      const subject =
        saved?.subject ??
        pending?.subject ??
        (yield* freshSubject(input.name, input.environmentId));
      const { grant, sessionId } = yield* issueGrant(subject, input.name, input.linkBaseUrl);
      yield* revoke(pending?.sessionId);
      invited.set(input.environmentId, { subject, name: input.name, sessionId });
      return grant;
    },
  );

  /**
   * A new colleague takes their name's subject only while nothing here uses it: a one-time guest
   * or another colleague of that name keeps their shares, and this one gets the environment suffix.
   */
  const freshSubject = Effect.fn("ColleaguesFork.freshSubject")(function* (
    name: string,
    environmentId: string,
  ) {
    const named = collaboratorSubject(name);
    const rows = yield* SubscriptionRef.get(ref);
    const sessions = yield* auth.listSessions().pipe(Effect.mapError(storageError));
    const links = yield* auth.listPairingLinks().pipe(Effect.mapError(storageError));
    const taken =
      shares.nameOf(named) !== undefined ||
      rows.some((row) => row.subject === named) ||
      sessions.some((session) => session.subject === named) ||
      links.some((link) => link.subject === named);
    return taken ? `${named}-${environmentId.slice(0, 8).toLowerCase()}` : named;
  });

  const save: ColleaguesFork["Service"]["save"] = Effect.fn("ColleaguesFork.save")(
    function* (subject, input) {
      const name = isCollaboratorSubject(subject) ? shares.nameOf(subject) : undefined;
      if (name === undefined) {
        return yield* fail(
          "refused",
          "Only a collaborator with a shared thread saves its sharer.",
        )();
      }
      const { grant, sessionId } = yield* issueGrant(subject, name, input.linkBaseUrl);
      yield* store(subject, name, input.grant, sessionId).pipe(
        Effect.onError(() => revoke(sessionId)),
      );
      return grant;
    },
  );

  const connect: ColleaguesFork["Service"]["connect"] = Effect.fn("ColleaguesFork.connect")(
    function* (input) {
      if (!isCollaboratorSubject(input.subject)) {
        return yield* fail("invalid", "That subject is not a collaborator's.")();
      }
      const pending = invited.get(input.grant.environmentId);
      const sessionId = pending?.subject === input.subject ? pending.sessionId : null;
      const colleague = yield* store(input.subject, input.name, input.grant, sessionId);
      invited.delete(input.grant.environmentId);
      return colleague;
    },
  );

  const tokenOf = (row: ColleagueRow) =>
    secrets.get(row.secret_name).pipe(
      Effect.mapError(storageError),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(storageError()),
          onSome: (bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
        }),
      ),
    );

  /** Posts to the colleague's server with its grant; their refusal and silence fail apart. */
  const callRemote = Effect.fn("ColleaguesFork.callRemote")(function* (
    row: ColleagueRow,
    route: string,
  ) {
    const token = yield* tokenOf(row);
    return yield* httpClient
      .execute(
        HttpClientRequest.post(`${row.url}${route}`).pipe(HttpClientRequest.bearerToken(token)),
      )
      .pipe(
        Effect.timeout(REMOTE_TIMEOUT),
        Effect.mapError(fail("unreachable", `${row.name}'s server did not answer.`)),
        Effect.filterOrFail(
          (response) => response.status < 300,
          (response) =>
            response.status === 401 || response.status === 403
              ? fail("refused", `${row.name}'s server no longer accepts this one.`)()
              : fail("unreachable", `${row.name}'s server answered ${response.status}.`)(),
        ),
      );
  });

  const pairClient: ColleaguesFork["Service"]["pairClient"] = Effect.fn(
    "ColleaguesFork.pairClient",
  )(function* (subject) {
    const row = yield* rowOf(subject);
    const response = yield* callRemote(row, COLLEAGUE_PAIR_CLIENT_ROUTE_FORK);
    const pairing = yield* HttpClientResponse.schemaBodyJson(ClientPairingResponse)(response).pipe(
      Effect.mapError(fail("unreachable", `${row.name}'s server answered in an unknown shape.`)),
    );
    return { environmentId: EnvironmentId.make(row.environment_id), url: row.url, ...pairing };
  });

  /** Ends everything the subject holds here: live shares, sessions, links, and the saved row. */
  const forgetHere = Effect.fn("ColleaguesFork.forgetHere")(function* (row: ColleagueRow) {
    yield* shares.unshareAll(row.subject).pipe(Effect.mapError(storageError));
    const sessions = yield* auth.listSessions().pipe(Effect.mapError(storageError));
    yield* Effect.forEach(
      sessions.filter((session) => session.subject === row.subject),
      (session) => auth.revokeSession(session.sessionId).pipe(Effect.mapError(storageError)),
    );
    const links = yield* auth.listPairingLinks().pipe(Effect.mapError(storageError));
    yield* Effect.forEach(
      links.filter((link) => link.subject === row.subject),
      (link) => auth.revokePairingLink(link.id).pipe(Effect.mapError(storageError)),
    );
    yield* sql`DELETE FROM fork_colleagues WHERE subject = ${row.subject}`.pipe(
      Effect.mapError(storageError),
    );
    yield* secrets.remove(row.secret_name).pipe(Effect.ignore);
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
      yield* forgetHere(row);
      return { endedThere };
    },
  );

  const issueClientPairing: ColleaguesFork["Service"]["issueClientPairing"] = Effect.fn(
    "ColleaguesFork.issueClientPairing",
  )(function* (subject) {
    // The sharer's app attaches as soon as its server saved us, which can beat our `connect`.
    const pending = [...invited.values()].find((invite) => invite.subject === subject);
    const name = pending?.name ?? (yield* rowOf(subject)).name;
    const issued = yield* auth
      .createPairingLink({
        subject,
        label: `Colleague ${name}`,
        scopes: COLLABORATOR_SCOPES,
        ttl: CLIENT_PAIRING_TTL,
      })
      .pipe(Effect.mapError(storageError));
    return {
      credential: TrimmedNonEmptyString.make(issued.credential),
      expiresAt: IsoDateTime.make(DateTime.formatIso(issued.expiresAt)),
    };
  });

  const forget: ColleaguesFork["Service"]["forget"] = (subject) =>
    rowOf(subject).pipe(Effect.flatMap(forgetHere));

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

  return ColleaguesFork.of({
    invite,
    save,
    connect,
    list: SubscriptionRef.get(ref).pipe(Effect.map((rows) => rows.map(toColleague))),
    changes: SubscriptionRef.changes(ref).pipe(Stream.map((rows) => rows.map(toColleague))),
    shareThread,
    pairClient,
    remove,
    issueClientPairing,
    forget,
  });
});

/** Carries the share service, which it builds on, so the server provides both from one place. */
export const layer = Layer.effect(ColleaguesFork, make).pipe(
  Layer.provideMerge(CollaboratorShares.layer),
);
