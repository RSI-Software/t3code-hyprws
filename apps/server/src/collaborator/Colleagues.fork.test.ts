import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  AuthSessionId,
  COLLABORATOR_SCOPES,
  COLLEAGUE_FORGET_ROUTE_FORK,
  COLLEAGUE_PAIR_CLIENT_ROUTE_FORK,
  type ColleagueErrorFork,
  EnvironmentId,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import * as CollaboratorShares from "./CollaboratorShares.fork.ts";
import * as Colleagues from "./Colleagues.fork.ts";

const now = DateTime.makeUnsafe("2026-11-25T00:00:00.000Z");
const instanceId = ProviderInstanceId.make("codex");
const threadShell = (id: string): OrchestrationV2ThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make(`p-${id}`),
  title: `Thread ${id}`,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** One in-process T3 server: its auth state, and the services under test. */
interface Server {
  readonly origin: string;
  readonly environmentId: EnvironmentId;
  readonly sessions: Map<
    string,
    {
      readonly sessionId: string;
      readonly subject: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope> | undefined;
    }
  >;
  readonly links: Array<{
    readonly id: string;
    readonly subject: string;
    readonly label: string | undefined;
    readonly scopes: unknown;
  }>;
  readonly secrets: Map<string, Uint8Array>;
  /** Runs before each pairing code is recorded; a test holds it to interleave another call. */
  pairingGate: Effect.Effect<void>;
  /** Revokes a session as Settings → Connections does, announcing it. */
  readonly revoke: (sessionId: string) => Effect.Effect<void>;
  readonly colleagues: Colleagues.ColleaguesFork["Service"];
  readonly shares: CollaboratorShares.CollaboratorSharesFork["Service"];
  /** The colleague service as a restarted server builds it, over the same database. */
  readonly restarted: Effect.Effect<Colleagues.ColleaguesFork["Service"], never, Scope.Scope>;
}

/** The servers that answer, by origin; deleting one takes it off the network. */
const network = new Map<string, Server>();

const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], response: Response) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, response));

// Delivers a colleague call to the server at its origin, as its HTTP route would.
const networkClient = HttpClient.make((request) => {
  const url = new URL(request.url);
  const server = network.get(url.origin);
  if (server === undefined) return json(request, new Response(null, { status: 404 }));
  const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const session = server.sessions.get(token);
  if (session === undefined) return json(request, new Response(null, { status: 401 }));
  const answer: Effect.Effect<object | undefined, ColleagueErrorFork> =
    url.pathname === COLLEAGUE_PAIR_CLIENT_ROUTE_FORK
      ? server.colleagues.issueClientPairing({
          subject: session.subject,
          scopes: session.scopes ?? COLLABORATOR_SCOPES,
        })
      : url.pathname === COLLEAGUE_FORGET_ROUTE_FORK
        ? server.colleagues.forget(session.subject).pipe(Effect.as({}))
        : Effect.undefined;
  return answer.pipe(
    Effect.map((body) =>
      body === undefined ? new Response(null, { status: 404 }) : Response.json(body),
    ),
    Effect.orElseSucceed(() => new Response(null, { status: 403 })),
    Effect.flatMap((response) => json(request, response)),
  );
});

const makeServer = Effect.fn("makeServer")(function* (name: string, port: number) {
  const environmentId = EnvironmentId.make(`env-${name}`);
  const sessions: Server["sessions"] = new Map();
  const links: Server["links"] = [];
  const secrets: Server["secrets"] = new Map();
  let issued = 0;
  const removed = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
  const dropSession = (sessionId: string) =>
    Effect.sync(() => {
      for (const [token, session] of sessions) {
        if (session.sessionId === sessionId) sessions.delete(token);
      }
    }).pipe(
      Effect.andThen(
        Queue.offer(removed, { type: "clientRemoved", sessionId: AuthSessionId.make(sessionId) }),
      ),
    );
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    issueSession: (input) =>
      Effect.sync(() => {
        const token = `${name}-token-${++issued}`;
        const sessionId = `${name}-session-${issued}`;
        sessions.set(token, { sessionId, subject: input!.subject!, scopes: input!.scopes });
        return { token, sessionId } as never;
      }),
    listSessions: () => Effect.succeed([...sessions.values()] as never),
    revokeSession: (sessionId) => dropSession(sessionId).pipe(Effect.as(true)),
    createPairingLink: (input) =>
      Effect.suspend(() => server.pairingGate).pipe(
        Effect.map(() => {
          links.push({
            id: `${name}-link-${++issued}`,
            subject: input!.subject!,
            label: input!.label,
            scopes: input!.scopes,
          });
          return { credential: `${name}-pairing-${issued}`, expiresAt: now } as never;
        }),
      ),
    listPairingLinks: () => Effect.succeed(links as never),
    revokePairingLink: (id) =>
      Effect.sync(() => {
        links.splice(
          links.findIndex((link) => link.id === id),
          1,
        );
        return true;
      }),
  });
  const sessionStore = Layer.mock(SessionStore.SessionStore)({
    cookieName: "unused",
    legacyCookieName: undefined,
    streamChanges: Stream.fromQueue(removed),
  });
  const secretStore = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (key) => Effect.succeed(Option.fromNullishOr(secrets.get(key))),
    set: (key, value) => Effect.sync(() => void secrets.set(key, value)),
    remove: (key) => Effect.sync(() => void secrets.delete(key)),
  });
  const environment = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getDescriptor: Effect.succeed({ environmentId, label: name } as never),
  });
  const config = Layer.succeed(ServerConfig.ServerConfig, {
    host: "127.0.0.1",
    port,
    privateNetworkOnly: false,
    devUrl: undefined,
  } as never as ServerConfig.ServerConfig["Service"]);
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(threadShell(threadId)),
  });
  const database = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  yield* ensureForkSchema().pipe(Effect.provide(database));
  const build = Layer.build(
    Colleagues.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(database),
          NodeCrypto.layer,
          auth,
          sessionStore,
          secretStore,
          environment,
          config,
          threads,
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
            latestApplicationSequence: Effect.succeed(0),
            streamApplicationEvents: () => Stream.never,
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: () => Effect.succeed({ stdout: "" } as never),
          }),
          Layer.succeed(HttpClient.HttpClient, networkClient),
        ),
      ),
    ),
  );
  const context = yield* build;
  const server: Server = {
    origin: `http://127.0.0.1:${port}`,
    environmentId,
    sessions,
    links,
    secrets,
    pairingGate: Effect.void,
    revoke: (sessionId) => dropSession(sessionId),
    colleagues: Context.get(context, Colleagues.ColleaguesFork),
    shares: Context.get(context, CollaboratorShares.CollaboratorSharesFork),
    restarted: build.pipe(Effect.map((next) => Context.get(next, Colleagues.ColleaguesFork))),
  };
  network.set(server.origin, server);
  return server;
});

/** Sam's app, paired with the host's link: the session its accept steps call the host with. */
const samApp = { subject: "colleague:sam", sessionId: AuthSessionId.make("sam-app") };

const asColleague = (subject: string) => ({ subject, scopes: COLLABORATOR_SCOPES });

const subjectsOf = (server: Server) => [...server.sessions.values()].map(({ subject }) => subject);

/**
 * The host shares a thread with Sam through a link; Sam accepts it in their own app, which runs the
 * three accept steps against their own server and the host's.
 */
const accept = Effect.fn("accept")(function* (host: Server, sam: Server) {
  const samGrant = yield* sam.colleagues.invite({ environmentId: host.environmentId, name: "Jo" });
  const hostGrant = yield* host.colleagues.save(samApp, { grant: samGrant });
  return yield* sam.colleagues.connect({ subject: samGrant.subject, name: "Jo", grant: hostGrant });
});

const servers = Effect.gen(function* () {
  network.clear();
  const host = yield* makeServer("host", 3801);
  const sam = yield* makeServer("sam", 3802);
  yield* host.shares.share({ threadId: ThreadId.make("host-thread"), collaboratorName: "Sam" });
  // Sam's app paired with the link: a collaborator session on the host.
  host.sessions.set("sam-app", { sessionId: "sam-app", subject: "colleague:sam" });
  return { host, sam };
});

const acceptedInvite = Effect.gen(function* () {
  const { host, sam } = yield* servers;
  yield* accept(host, sam);
  return { host, sam };
});

const grantFrom = (server: Server) => ({
  environmentId: server.environmentId,
  url: server.origin,
  subject: "colleague:x",
  token: Redacted.make("unused"),
});

const shellThreads = (item: OrchestrationV2ShellStreamItem) =>
  item.kind === "snapshot" ? item.snapshot.threads.map((thread) => thread.id) : [];

it.effect("an accepted invite saves each side as the other's colleague, fenced per thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;

      const [samOnHost] = yield* host.colleagues.list;
      assert.deepInclude(samOnHost, {
        subject: "colleague:sam",
        name: "Sam",
        environmentId: sam.environmentId,
        url: sam.origin,
      });
      const [hostOnSam] = yield* sam.colleagues.list;
      assert.deepInclude(hostOnSam, {
        subject: "colleague:jo",
        name: "Jo",
        environmentId: host.environmentId,
        url: host.origin,
      });
      // Each server holds a grant from the other, as the colleague's subject there.
      assert.include(subjectsOf(host), "colleague:sam");
      assert.include(subjectsOf(sam), "colleague:jo");

      // Sam shares back with no link: the host's grant on Sam's server sees nothing until then.
      const narrowed = sam.shares.wrapHandlers("colleague:jo", {
        "orchestration.dispatchCommand": () => Effect.void,
        "orchestration.launchThread": () => Effect.void,
        "orchestration.subscribeShell": () =>
          Stream.make({
            kind: "snapshot",
            snapshot: {
              threads: ["sam-1", "sam-2"].map(threadShell),
              archivedThreads: [],
              projects: [],
            },
          } as never as OrchestrationV2ShellStreamItem),
        "orchestration.subscribeThread": () => Stream.empty,
        "orchestration.subscribeCommandOutput": () => Stream.empty,
      });
      const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      yield* narrowed["orchestration.subscribeShell"]({}, undefined as never).pipe(
        Stream.runForEach((item) => Queue.offer(items, item)),
        Effect.forkScoped,
      );
      assert.deepStrictEqual(shellThreads(yield* Queue.take(items)), []);
      yield* sam.colleagues.shareThread({
        threadId: ThreadId.make("sam-2"),
        subject: "colleague:jo",
      });
      assert.deepStrictEqual(shellThreads(yield* Queue.take(items)), ["sam-2"]);
      assert.deepStrictEqual(
        (yield* sam.colleagues.list).map((colleague) => colleague.threadIds),
        [[ThreadId.make("sam-2")]],
      );
      assert.isFalse(sam.links.some((link) => link.subject === "colleague:jo"));

      // The host's app attaches Sam's environment with a one-time code Sam's server mints.
      const pairing = yield* host.colleagues.pairClient("colleague:sam");
      assert.strictEqual(pairing.environmentId, sam.environmentId);
      assert.strictEqual(pairing.url, sam.origin);
      assert.deepStrictEqual(sam.links.at(-1), {
        id: sam.links.at(-1)!.id,
        subject: "colleague:jo",
        label: "Colleague Jo",
        scopes: COLLABORATOR_SCOPES,
      });

      // Only a collaborator the host shared with saves back; only a saved colleague gets codes.
      const owner = yield* Effect.exit(
        host.colleagues.save(
          { subject: "owner", sessionId: AuthSessionId.make("owner-app") },
          { grant: grantFrom(sam) },
        ),
      );
      assert.isTrue(Exit.isFailure(owner));
      const stranger = yield* Effect.exit(
        sam.colleagues.issueClientPairing(asColleague("colleague:eve")),
      );
      assert.isTrue(Exit.isFailure(stranger));
    }),
  ),
);

it.effect("removing a colleague ends their access on both sides", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;
      yield* sam.colleagues.shareThread({
        threadId: ThreadId.make("sam-1"),
        subject: "colleague:jo",
      });

      assert.deepStrictEqual(yield* host.colleagues.remove("colleague:sam"), { endedThere: true });
      // Every session Sam held on the host, app and server, and every share, ends.
      assert.notInclude(subjectsOf(host), "colleague:sam");
      assert.isFalse(host.shares.isShared("colleague:sam", "host-thread"));
      assert.deepStrictEqual(yield* host.colleagues.list, []);
      assert.strictEqual(host.secrets.size, 0);
      // Sam's server dropped the host the same way.
      assert.notInclude(subjectsOf(sam), "colleague:jo");
      assert.isFalse(sam.shares.isShared("colleague:jo", "sam-1"));
      assert.deepStrictEqual(yield* sam.colleagues.list, []);
      assert.strictEqual(sam.secrets.size, 0);
    }),
  ),
);

it.effect("an unreachable colleague is still removed here, and says so", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;
      network.delete(sam.origin);

      const pairing = yield* Effect.flip(host.colleagues.pairClient("colleague:sam"));
      assert.strictEqual(pairing._tag, "ColleagueRemoteErrorFork");
      assert.deepStrictEqual(yield* host.colleagues.remove("colleague:sam"), { endedThere: false });
      assert.deepStrictEqual(yield* host.colleagues.list, []);
      assert.notInclude(subjectsOf(host), "colleague:sam");
    }),
  ),
);

it.effect("accepting again replaces each side's grant instead of adding one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;
      yield* accept(host, sam);

      // The host keeps Sam's app session and one grant; Sam keeps one grant for the host.
      assert.deepStrictEqual(
        subjectsOf(host).filter((subject) => subject === "colleague:sam"),
        ["colleague:sam", "colleague:sam"],
      );
      assert.isTrue(host.sessions.has("sam-app"));
      assert.deepStrictEqual(subjectsOf(sam), ["colleague:jo"]);
      assert.strictEqual(host.secrets.size, 1);
      assert.strictEqual(sam.secrets.size, 1);
    }),
  ),
);

it.effect("a new colleague never takes over a one-time guest's shares under their name", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* servers;
      // Before accepting, Sam shared by link with a guest also called Jo, and with one holding
      // the suffixed subject a new colleague would fall back to.
      yield* sam.shares.share({ threadId: ThreadId.make("sam-guest"), collaboratorName: "Jo" });
      yield* sam.shares.share({
        threadId: ThreadId.make("sam-guest-2"),
        collaboratorName: "Jo env-host",
      });

      const hostOnSam = yield* accept(host, sam);
      assert.notInclude(["colleague:jo", "colleague:jo-env-host"], hostOnSam.subject);
      assert.isFalse(sam.shares.isShared(hostOnSam.subject, "sam-guest"));
      assert.isFalse(sam.shares.isShared(hostOnSam.subject, "sam-guest-2"));
      assert.isTrue(sam.shares.isShared("colleague:jo", "sam-guest"));
      assert.isTrue(sam.shares.isShared("colleague:jo-env-host", "sam-guest-2"));
    }),
  ),
);

it.effect("the sharer's app can attach the colleague before the accept's last step", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* servers;
      const samGrant = yield* sam.colleagues.invite({
        environmentId: host.environmentId,
        name: "Jo",
      });
      yield* host.colleagues.save(samApp, { grant: samGrant });

      const pairing = yield* host.colleagues.pairClient("colleague:sam");
      assert.strictEqual(pairing.environmentId, sam.environmentId);
    }),
  ),
);

it.effect("a collaborator cannot save over another colleague's environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;
      yield* host.shares.share({ threadId: ThreadId.make("eve-thread"), collaboratorName: "Eve" });
      host.sessions.set("eve-app", { sessionId: "eve-app", subject: "colleague:eve" });

      const evicted = yield* Effect.flip(
        host.colleagues.save(
          { subject: "colleague:eve", sessionId: AuthSessionId.make("eve-app") },
          { grant: { ...grantFrom(sam), url: "http://127.0.0.1:3899" } },
        ),
      );
      assert.strictEqual(evicted._tag, "ColleagueSavedAsAnotherErrorFork");
      assert.deepStrictEqual(
        (yield* host.colleagues.list).map(({ subject, url }) => ({ subject, url })),
        [{ subject: "colleague:sam", url: sam.origin }],
      );
      assert.include(subjectsOf(host), "colleague:sam");
    }),
  ),
);

it.effect("a collaborator whose session is revoked loses the colleague grant they saved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;
      const forgotten = yield* host.colleagues.changes.pipe(
        Stream.filter((rows) => rows.length === 0),
        Stream.runHead,
        Effect.forkScoped,
      );

      yield* host.revoke("sam-app");
      yield* Fiber.join(forgotten);
      assert.notInclude(subjectsOf(host), "colleague:sam");
      assert.isFalse(host.shares.isShared("colleague:sam", "host-thread"));
      const refused = yield* Effect.exit(
        host.colleagues.issueClientPairing(asColleague("colleague:sam")),
      );
      assert.isTrue(Exit.isFailure(refused));
      assert.isFalse(host.links.some((link) => link.subject === "colleague:sam"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sam.colleagues.pairClient("colleague:jo"))));
    }),
  ),
);

it.effect("a pairing request is refused once the session that saved the colleague is gone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* servers;
      yield* host.colleagues.save(samApp, { grant: grantFrom(sam) });
      // Gone without an announcement, as a session that lapsed while this server was down.
      host.sessions.delete("sam-app");

      const refused = yield* Effect.exit(
        host.colleagues.issueClientPairing(asColleague("colleague:sam")),
      );
      assert.isTrue(Exit.isFailure(refused));
      assert.notInclude(subjectsOf(host), "colleague:sam");
      assert.deepStrictEqual(yield* host.colleagues.list, []);
    }),
  ),
);

it.effect("each client's pairing code survives another client's request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;

      const first = yield* host.colleagues.pairClient("colleague:sam");
      const second = yield* host.colleagues.pairClient("colleague:sam");
      assert.notStrictEqual(first.credential, second.credential);
      assert.strictEqual(sam.links.filter((link) => link.subject === "colleague:jo").length, 2);
    }),
  ),
);

it.effect("a pairing code never carries more than the colleague's grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;
      // The host's grant on Sam's server, narrowed to reading.
      for (const [token, session] of sam.sessions) {
        if (session.subject !== "colleague:jo") continue;
        sam.sessions.set(token, { ...session, scopes: [AuthOrchestrationReadScope] });
      }

      yield* host.colleagues.pairClient("colleague:sam");
      assert.deepStrictEqual(sam.links.at(-1)?.scopes, [AuthOrchestrationReadScope]);
      const scopeless = yield* Effect.flip(
        sam.colleagues.issueClientPairing({ subject: "colleague:jo", scopes: [] }),
      );
      assert.strictEqual(scopeless._tag, "ColleagueNoScopeErrorFork");
    }),
  ),
);

it.effect("a colleague forgotten mid-request keeps no pairing code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sam } = yield* acceptedInvite;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      sam.pairingGate = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );

      const issuing = yield* sam.colleagues
        .issueClientPairing(asColleague("colleague:jo"))
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered);
      const forgetting = yield* sam.colleagues
        .forget("colleague:jo")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(issuing);
      yield* Fiber.join(forgetting);

      assert.deepStrictEqual(yield* sam.colleagues.list, []);
      assert.isFalse(sam.links.some((link) => link.subject === "colleague:jo"));
    }),
  ),
);

it.effect("messages queued for an offline colleague keep their order past a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, sam } = yield* acceptedInvite;
      const threadId = ThreadId.make("host-thread");
      const outbox = (colleagues: Server["colleagues"]) =>
        colleagues.outbox.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      const texts = (colleagues: Server["colleagues"]) =>
        outbox(colleagues).pipe(Effect.map((queued) => queued.map(({ text }) => text)));

      for (const text of ["first", "second", "third"]) {
        yield* sam.colleagues.queueMessage({ environmentId: host.environmentId, threadId, text });
      }
      const [, second] = yield* outbox(sam.colleagues);
      yield* sam.colleagues.unqueueMessage(second!.id);
      const stranger = yield* Effect.exit(
        sam.colleagues.queueMessage({
          environmentId: EnvironmentId.make("env-stranger"),
          threadId,
          text: "hi",
        }),
      );
      assert.isTrue(Exit.isFailure(stranger));

      const restarted = yield* sam.restarted;
      assert.deepStrictEqual(yield* texts(restarted), ["first", "third"]);
      assert.deepStrictEqual(
        (yield* outbox(restarted)).map(({ environmentId }) => environmentId),
        [host.environmentId, host.environmentId],
      );

      // Removing the colleague drops what waited for them.
      yield* sam.colleagues.remove("colleague:jo");
      assert.deepStrictEqual(yield* texts(sam.colleagues), []);
    }),
  ),
);
