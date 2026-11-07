import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentAuthenticatedPrincipal,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { collaboratorPrompt } from "./CollaboratorMessages.fork.ts";
import * as CollaboratorShares from "./CollaboratorShares.fork.ts";

const shared = ThreadId.make("shared");
const other = ThreadId.make("other");
const sharedProject = ProjectId.make("p-shared");
const otherProject = ProjectId.make("p-other");
const projectOf = { [shared]: sharedProject, [other]: otherProject } as Record<string, ProjectId>;
const pairedSubjects = new Set<string>();

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const instanceId = ProviderInstanceId.make("codex");
const threadShell = (id: ThreadId): OrchestrationV2ThreadShell => ({
  id,
  projectId: projectOf[id]!,
  title: `Thread ${id}`,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
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

const hostDispatches: Array<OrchestrationV2Command> = [];
const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(threadShell(ThreadId.make(threadId))),
  // Yields first, as a real dispatch does, so concurrent sends interleave.
  dispatch: (command) =>
    Effect.yieldNow.pipe(
      Effect.andThen(Effect.sync(() => hostDispatches.push(command as OrchestrationV2Command))),
      Effect.as({} as never),
    ),
});
const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  createPairingLink: () => Effect.succeed({ credential: "token" } as never),
  listSessions: () => Effect.succeed([...pairedSubjects].map((subject) => ({ subject }) as never)),
});
const config = Layer.succeed(ServerConfig.ServerConfig, {
  host: "127.0.0.1",
  port: 3773,
  privateNetworkOnly: false,
  devUrl: undefined,
} as never as ServerConfig.ServerConfig["Service"]);

const database = it.layer(
  Layer.mergeAll(
    NodeSqliteClient.layer({ filename: ":memory:" }),
    NodeCrypto.layer,
    threads,
    auth,
    config,
  ),
);
type Ingress = ReadonlyArray<{ hostname?: string; path?: string; service: string }>;

// A local cloudflared answering on its first metrics port with these ingress rules, or none.
const tunnelClient = (ingress?: Ingress) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      ingress !== undefined && request.url === "http://127.0.0.1:20241/config"
        ? Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ config: { ingress } })),
          )
        : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
    ),
  );

const withService = <A, E>(
  effect: Effect.Effect<A, E, CollaboratorShares.CollaboratorSharesFork | SqlClient.SqlClient>,
  tunnel?: Ingress,
) =>
  Effect.andThen(
    ensureForkSchema(),
    Effect.provide(effect, CollaboratorShares.layer.pipe(Layer.provide(tunnelClient(tunnel)))),
  );

const snapshot = () =>
  ({
    kind: "snapshot",
    snapshot: {
      threads: [shared, other].map((id) => ({ id, projectId: projectOf[id] })),
      archivedThreads: [],
      projects: [{ id: sharedProject }, { id: otherProject }],
    },
  }) as never as OrchestrationV2ShellStreamItem;
// Live shell events after each snapshot; the shell test supplies the queue.
const shellEvents: { queue?: Queue.Queue<OrchestrationV2ShellStreamItem> } = {};

const shellInputs: Array<object> = [];
const threadInputs: Array<number | undefined> = [];
const handlers = {
  "orchestration.dispatchCommand": (command: OrchestrationV2Command, _options: never) =>
    Effect.succeed(command),
  "orchestration.launchThread": (input: OrchestrationV2ThreadLaunchInput, _options: never) =>
    Effect.succeed(input),
  "orchestration.subscribeShell": (input: object, _options: never) => {
    shellInputs.push(input);
    return Stream.concat(
      Stream.make(snapshot()),
      shellEvents.queue ? Stream.fromQueue(shellEvents.queue) : Stream.empty,
    );
  },
  "orchestration.subscribeThread": (
    input: { readonly afterSequence?: number | undefined },
    _options: never,
  ) => {
    threadInputs.push(input.afterSequence);
    return Stream.concat(
      Stream.make({ kind: "event", sequence: 4 } as never as OrchestrationV2ThreadStreamItem),
      Stream.never,
    );
  },
};

const visibleThreads = (item: OrchestrationV2ShellStreamItem) =>
  item.kind === "snapshot" ? item.snapshot.threads.map((thread) => thread.id) : [];
const frozenThreads = (item: OrchestrationV2ShellStreamItem) =>
  item.kind === "snapshot"
    ? item.snapshot.threads
        .filter((thread) => thread.collaboratorFork === "frozen")
        .map(({ id }) => id)
    : [];

const visibleProjects = (item: OrchestrationV2ShellStreamItem) =>
  item.kind === "snapshot" ? item.snapshot.projects.map(({ id }) => id) : [];

const message = (threadId: ThreadId, type = "message.dispatch", text = "hi", context?: object) =>
  ({ type, threadId, text, context }) as never as OrchestrationV2Command;
const sentText = (command: OrchestrationV2Command) => ("text" in command ? command.text : "");
const sentContext = (command: OrchestrationV2Command) =>
  "context" in command ? command.context : undefined;
const sentAuthor = (command: OrchestrationV2Command) => sentContext(command)?.collaboratorFork;

database("CollaboratorSharesFork", (it) => {
  it.effect("narrows a collaborator's shell live, from a fresh snapshot on every change", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* CollaboratorShares.CollaboratorSharesFork;
        const wrapped = service.wrapHandlers("colleague:sam", handlers);
        const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        shellEvents.queue = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const fiber = yield* wrapped["orchestration.subscribeShell"](
          { afterSequence: 7, omitIdleSubagents: true, omitOlderSettled: true },
          undefined as never,
        ).pipe(
          Stream.runForEach((item) => Queue.offer(items, item)),
          Effect.forkChild,
        );

        assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
        yield* service.share({ threadId: shared, collaboratorName: "Sam" });
        const afterShare = yield* Queue.take(items);
        assert.deepStrictEqual(visibleThreads(afterShare), [shared]);
        assert.deepStrictEqual(visibleProjects(afterShare), [sharedProject]);
        // A project metadata refresh carries no threads; it keeps the visible projects.
        yield* Queue.offer(shellEvents.queue, {
          ...snapshot(),
          snapshot: { threads: [], archivedThreads: [], projects: [{ id: sharedProject }] },
          resolvedRepositoryIdentityRoots: [],
        } as never);
        assert.deepStrictEqual(visibleProjects(yield* Queue.take(items)), [sharedProject]);
        // Moving the shared thread to a hidden project re-snapshots with that project.
        projectOf[shared] = otherProject;
        yield* Queue.offer(shellEvents.queue, {
          kind: "thread.updated",
          thread: { id: shared, projectId: otherProject },
        } as never);
        assert.deepStrictEqual(visibleProjects(yield* Queue.take(items)), [otherProject]);
        projectOf[shared] = sharedProject;
        // Stopping keeps a frozen copy; a re-share returns the live thread.
        yield* service.unshare({ threadId: shared, subject: "colleague:sam" });
        const afterStop = yield* Queue.take(items);
        assert.deepStrictEqual(frozenThreads(afterStop), [shared]);
        assert.deepStrictEqual(visibleProjects(afterStop), [sharedProject]);
        yield* service.share({ threadId: shared, collaboratorName: "Sam" });
        const afterReshare = yield* Queue.take(items);
        assert.deepStrictEqual(visibleThreads(afterReshare), [shared]);
        assert.deepStrictEqual(frozenThreads(afterReshare), []);
        assert.deepStrictEqual(shellInputs.map(Object.keys), [[], [], [], [], []]);
        yield* Fiber.interrupt(fiber);

        // The host's own sends cannot claim a collaborator wrote them.
        const owner = service.wrapHandlers("owner", handlers);
        const claimed = message(shared, "message.dispatch", "hi", {
          version: 1,
          records: [],
          collaboratorFork: { name: "Sam", text: "hi" },
        });
        const ownerSent = yield* owner["orchestration.dispatchCommand"](
          claimed,
          undefined as never,
        );
        assert.isUndefined(sentAuthor(ownerSent));
        const launched = yield* owner["orchestration.launchThread"](
          {
            initialMessage: { text: "hi", context: sentContext(claimed), attachments: [] },
          } as never,
          undefined as never,
        );
        assert.isUndefined(launched.initialMessage?.context?.collaboratorFork);
      }),
    ),
  );

  it.effect("limits a collaborator to shared threads and names them in their messages", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* CollaboratorShares.CollaboratorSharesFork;
        const result = yield* service.share({
          threadId: shared,
          collaboratorName: "Sam",
          access: "send",
        });
        assert.isFalse(result.knownCollaborator);
        assert.strictEqual(new URL(result.pairingUrl).searchParams.get("thread"), shared);
        // Like ws.ts, assign the wrapped handlers back onto the object they wrap.
        const wrapped = { ...handlers };
        Object.assign(wrapped, service.wrapHandlers("colleague:sam", wrapped));
        const dispatch = wrapped["orchestration.dispatchCommand"];

        const attributed = collaboratorPrompt("Sam", "hi");
        const sent = yield* dispatch(message(shared), undefined as never);
        assert.strictEqual(sentText(sent), attributed);
        assert.deepStrictEqual(sentAuthor(sent), { name: "Sam", text: "hi" });
        for (const text of ["hi", attributed]) {
          const edit = message(shared, "queued-run.edit", text);
          assert.strictEqual(sentText(yield* dispatch(edit, undefined as never)), attributed);
        }
        const refused = yield* Effect.exit(dispatch(message(other), undefined as never));
        assert.isTrue(Exit.isFailure(refused));
        const live = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
        const open = yield* wrapped["orchestration.subscribeThread"](
          { threadId: shared } as never,
          undefined as never,
        ).pipe(
          Stream.runForEach((item) => Queue.offer(live, item)),
          Effect.forkChild,
        );
        yield* Queue.take(live);
        // Stopping freezes the thread: its stream reports the cached copy current, sends are
        // refused, and a re-share resumes after sequence 4.
        yield* service.unshare({ threadId: shared, subject: "colleague:sam" });
        assert.deepStrictEqual(yield* Queue.take(live), { kind: "synchronized" });
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(dispatch(message(shared), undefined as never))),
        );
        const stopped = yield* service.threadShares(shared);
        assert.deepStrictEqual(stopped.sharedWith, []);
        assert.deepStrictEqual(stopped.collaborators, [{ subject: "colleague:sam", name: "Sam" }]);
        // A re-share keeps the access it had.
        yield* service.share({ threadId: shared, collaboratorName: "Sam" });
        assert.deepStrictEqual((yield* service.threadShares(shared)).sharedWith, [
          { subject: "colleague:sam", name: "Sam", access: "send" },
        ]);
        yield* Queue.take(live);
        assert.deepStrictEqual(threadInputs, [undefined, 4]);
        yield* Fiber.interrupt(open);

        pairedSubjects.add("colleague:sam");
        const again = yield* service.share({ threadId: shared, collaboratorName: "Sam" });
        assert.isTrue(again.knownCollaborator);
      }),
    ),
  );

  it.effect("holds an approve collaborator's messages until the host sends them", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* CollaboratorShares.CollaboratorSharesFork;
        // The database is shared across tests, where Sam was given send access.
        yield* service.share({ threadId: shared, collaboratorName: "Sam", access: "approve" });
        yield* service.share({ threadId: shared, collaboratorName: "Ana" });
        hostDispatches.length = 0;
        const wrapped = { ...handlers };
        Object.assign(wrapped, service.wrapHandlers("colleague:sam", wrapped));
        const sam = service.messageHandlers("colleague:sam");
        const host = service.messageHandlers(null);
        const waiting = (handlers: typeof host) =>
          handlers["collaborator.subscribeMessagesFork"]().pipe(
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );

        // The agent gets nothing until the host sends.
        const direct = yield* Effect.exit(
          wrapped["orchestration.dispatchCommand"](message(shared), undefined as never),
        );
        assert.isTrue(Exit.isFailure(direct));
        yield* sam["collaborator.submitMessageFork"]({ threadId: shared, text: "first" });
        yield* sam["collaborator.submitMessageFork"]({ threadId: shared, text: "second" });
        assert.deepStrictEqual(
          (yield* waiting(host)).map(({ name, text }) => ({ name, text })),
          [
            { name: "Sam", text: "first" },
            { name: "Sam", text: "second" },
          ],
        );
        assert.deepStrictEqual(yield* waiting(service.messageHandlers("colleague:ana")), []);
        const [first, second] = yield* waiting(sam);

        // Sam may withdraw but never send; the host sends with Sam's name attached.
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              sam["collaborator.resolveMessageFork"]({
                threadId: shared,
                messageId: first!.id,
                decision: "send",
              }),
            ),
          ),
        );
        yield* sam["collaborator.resolveMessageFork"]({
          threadId: shared,
          messageId: second!.id,
          decision: "dismiss",
        });
        // Two tabs sending at once dispatch it once.
        const send = host["collaborator.resolveMessageFork"]({
          threadId: shared,
          messageId: first!.id,
          decision: "send",
        });
        yield* Effect.all([Effect.exit(send), Effect.exit(send)], { concurrency: "unbounded" });
        assert.deepStrictEqual(yield* waiting(host), []);
        assert.deepStrictEqual(
          hostDispatches.map((command) => [sentText(command), sentAuthor(command)]),
          [[collaboratorPrompt("Sam", "first"), { name: "Sam", text: "first" }]],
        );

        // Send access lets Sam's messages through directly, and refuses the approval path.
        yield* service.setAccess({ subject: "colleague:sam", threadId: shared, access: "send" });
        yield* wrapped["orchestration.dispatchCommand"](message(shared), undefined as never);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              sam["collaborator.submitMessageFork"]({ threadId: shared, text: "queued" }),
            ),
          ),
        );

        // An unshare whose purge fails leaves the share live; a retry purges and freezes.
        yield* service.setAccess({ subject: "colleague:sam", threadId: shared, access: "approve" });
        yield* sam["collaborator.submitMessageFork"]({ threadId: shared, text: "late" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          CREATE TRIGGER refuse_purge BEFORE DELETE ON fork_collaborator_messages
          BEGIN SELECT RAISE(ABORT, 'refused'); END
        `;
        const unshare = service.unshare({ threadId: shared, subject: "colleague:sam" });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(unshare)));
        assert.isTrue(service.isShared("colleague:sam", shared));
        assert.deepStrictEqual(
          (yield* waiting(sam)).map(({ text }) => text),
          ["late"],
        );
        yield* sql`DROP TRIGGER refuse_purge`;
        yield* unshare;
        assert.isFalse(service.isShared("colleague:sam", shared));
        assert.deepStrictEqual(yield* waiting(host), []);
      }),
    ),
  );

  it.effect("refuses a collaborator's RPCs outside its closed set and unshared threads", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* CollaboratorShares.CollaboratorSharesFork;
        yield* service.share({ threadId: shared, collaboratorName: "Sam" });
        const check = (subject: string, method: string, payload: unknown = {}) =>
          Effect.service(RpcScopeAuthorization).pipe(
            service.guardRpc(subject),
            Effect.provideService(RpcScopeAuthorization, (effect) => effect),
            Effect.flatMap((authorize) =>
              Effect.exit(
                authorize(Effect.void as never, { rpc: { _tag: method }, payload } as never),
              ),
            ),
            Effect.map(Exit.isSuccess),
            Effect.scoped,
          );
        const allowed = (method: string, payload: unknown = {}) =>
          check("colleague:sam", method, payload);
        assert.isTrue(yield* check("owner", WS_METHODS.terminalOpen));
        const turnDiff = ORCHESTRATION_V2_WS_METHODS.getTurnDiff;
        assert.isTrue(yield* allowed(WS_METHODS.serverGetConfig));
        assert.isTrue(yield* allowed(turnDiff, { threadId: shared }));
        assert.isFalse(yield* allowed(turnDiff, { threadId: other }));
        assert.isFalse(yield* allowed(WS_METHODS.terminalOpen));
        assert.isFalse(yield* allowed(WS_METHODS.projectsMutate));
        const asset = (resource: object) => allowed(WS_METHODS.assetsCreateUrl, { resource });
        assert.isTrue(yield* asset({ _tag: "attachment", attachmentId: "a" }));
        assert.isTrue(
          yield* asset({ _tag: "tool-output-image", threadId: shared, itemId: "i", index: 0 }),
        );
        assert.isFalse(
          yield* asset({ _tag: "tool-output-image", threadId: other, itemId: "i", index: 0 }),
        );
        assert.isFalse(
          yield* asset({ _tag: "workspace-file", threadId: shared, path: "/etc/passwd" }),
        );

        const httpRead = (subject: string, threadId: ThreadId) =>
          CollaboratorShares.requireCollaboratorHttpThreadFork(threadId).pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, { subject } as never),
            Effect.exit,
            Effect.map(Exit.isSuccess),
          );
        assert.isTrue(yield* httpRead("colleague:sam", shared));
        assert.isFalse(yield* httpRead("colleague:sam", other));
        assert.isTrue(yield* httpRead("owner", other));
      }),
    ),
  );

  it.effect("bases the link on the local tunnel, then the sharing client's public origin", () =>
    Effect.gen(function* () {
      const link = (linkBaseUrl: string, tunnel?: Ingress) =>
        withService(
          Effect.gen(function* () {
            const service = yield* CollaboratorShares.CollaboratorSharesFork;
            const { pairingUrl, localOnly } = yield* service.share({
              threadId: shared,
              collaboratorName: "Sam",
              linkBaseUrl,
            });
            return { origin: new URL(pairingUrl).origin, localOnly };
          }),
          tunnel,
        );
      assert.deepStrictEqual(
        yield* link("http://127.0.0.1:3773", [
          { hostname: "api.example.com", path: "^/api", service: "http://localhost:3773" },
          { hostname: "other.example.com", service: "http://localhost:4000" },
          { hostname: "other.example.com", service: "http://localhost:3773" },
          { hostname: "pair.example.com", path: "^/pair", service: "http://localhost:4000" },
          { hostname: "pair.example.com", service: "http://localhost:3773" },
          { hostname: "t3.example.com", service: "http://localhost:3773" },
          { service: "http_status:503" },
        ]),
        { origin: "https://t3.example.com", localOnly: false },
      );
      assert.deepStrictEqual(yield* link("https://app.example.com/x"), {
        origin: "https://app.example.com",
        localOnly: false,
      });
      for (const local of ["http://localhost:9999", "http://[fd00::1]:3773", "http://box.local"]) {
        assert.isTrue((yield* link(local)).localOnly, local);
      }
      assert.isTrue(
        (yield* link("http://localhost:9999", [
          { hostname: "*.example.com", service: "http://localhost:3773" },
        ])).localOnly,
      );
      assert.isTrue(
        (yield* link("http://localhost:9999", [
          { hostname: "*", path: "^/pair", service: "http://localhost:4000" },
          { hostname: "t3.example.com", service: "http://localhost:3773" },
        ])).localOnly,
      );
    }),
  );
});
