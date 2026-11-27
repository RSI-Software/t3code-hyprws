import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  COLLABORATOR_DRAFT_TEXT_MAX_CHARS,
  type CollaboratorDraftFork,
  CollaboratorSetTypingInputFork,
  CollaboratorSubmitMessageInputFork,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { collaboratorAttribution, hostAttribution } from "./CollaboratorMessages.fork.ts";
import * as CollaboratorShares from "./CollaboratorShares.fork.ts";

const shared = ThreadId.make("shared");
const other = ThreadId.make("other");
const sharedProject = ProjectId.make("p-shared");
const otherProject = ProjectId.make("p-other");
const projectOf = { [shared]: sharedProject, [other]: otherProject } as Record<string, ProjectId>;
const pairedSubjects = new Set<string>();
const pairingLabels: Array<string> = [];
const decodeSetTyping = Schema.decodeExit(CollaboratorSetTypingInputFork);
const decodeSubmitMessage = Schema.decodeEffect(CollaboratorSubmitMessageInputFork);

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
// Queued runs by id, with who the server attributed each message to; no name is the host.
const queuedAuthors: Record<string, string | undefined> = {
  "run-sam": "Sam",
  "run-pat": "Pat",
  "run-host": undefined,
};
const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(threadShell(ThreadId.make(threadId))),
  getThreadRecords: (_threadId, _fields, filter) =>
    Effect.succeed({
      runs: (filter?.runIds ?? [])
        .filter((id) => id in queuedAuthors)
        .map((id) => ({ id, userMessageId: `message-${id}` })),
    } as never),
  getMessagesById: (_threadId, messageIds) =>
    Effect.succeed(
      new Map(
        messageIds.map((id) => {
          const name = queuedAuthors[id.replace("message-", "")];
          return [id, { context: name === undefined ? undefined : { collaboratorFork: { name } } }];
        }),
      ) as never,
    ),
  // Yields first, as a real dispatch does, so concurrent sends interleave.
  dispatch: (command) =>
    Effect.yieldNow.pipe(
      Effect.andThen(Effect.sync(() => hostDispatches.push(command as OrchestrationV2Command))),
      Effect.as({} as never),
    ),
});
// Sent commands are accepted; a test may file a rejected one here.
const rejectedReceipts = new Set<string>();
const receipts = Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
  getByCommandId: (commandId) =>
    Effect.sync(() => {
      const accepted = hostDispatches.some((command) => command.commandId === commandId);
      return accepted || rejectedReceipts.has(commandId)
        ? Option.some({ threadId: shared, status: accepted ? "accepted" : "rejected" } as never)
        : Option.none();
    }),
});
const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  createPairingLink: (input) =>
    Effect.sync(() => pairingLabels.push(input?.label ?? "")).pipe(
      Effect.as({ credential: "token" } as never),
    ),
  listSessions: () => Effect.succeed([...pairedSubjects].map((subject) => ({ subject }) as never)),
});
const config = Layer.succeed(ServerConfig.ServerConfig, {
  host: "127.0.0.1",
  port: 3773,
  privateNetworkOnly: false,
  devUrl: undefined,
  cwd: "/",
} as never as ServerConfig.ServerConfig["Service"]);
// The host's git user.name, which the agent reads in shared threads.
const HOST = "Jordan Lee";
const collaboratorPrompt = (name: string, text: string) => collaboratorAttribution(name, text).text;
const git = Layer.mock(GitVcsDriver.GitVcsDriver)({
  execute: () => Effect.succeed({ stdout: `${HOST}\n` } as never),
});

// Project events wake the team marks; the team test supplies the queue.
const projectEvents: { queue?: Queue.Queue<object, Error> } = {};
const events = Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
  latestApplicationSequence: Effect.succeed(0),
  streamApplicationEvents: () =>
    projectEvents.queue ? (Stream.fromQueue(projectEvents.queue) as never) : Stream.never,
});

const database = it.layer(
  Layer.mergeAll(
    NodeSqliteClient.layer({ filename: ":memory:" }),
    NodeCrypto.layer,
    threads,
    receipts,
    auth,
    config,
    git,
    events,
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

const withService = <A, E, R>(effect: Effect.Effect<A, E, R>, tunnel?: Ingress) =>
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

it.effect("hands out the collaborator grant only to a session holding it", () =>
  Effect.gen(function* () {
    const denied = (scopes: ReadonlyArray<AuthEnvironmentScope>, method: string) =>
      Effect.service(RpcScopeAuthorization).pipe(
        Effect.flatMap((authorize) =>
          authorize(
            Effect.void as never,
            {
              rpc: { _tag: method },
              payload: { threadId: shared, collaboratorName: "Sam", access: "send" },
            } as never,
          ),
        ),
        Effect.provide(RpcAuthorization.layer(scopes)),
        Effect.flip,
        Effect.map(
          (error) => (error as { requiredPermission: AuthEnvironmentScope }).requiredPermission,
        ),
        Effect.orElseSucceed(() => null),
      );
    const manager = [AuthAccessWriteScope];
    const reader = [AuthAccessWriteScope, AuthOrchestrationReadScope];
    const host = [...reader, AuthOrchestrationOperateScope];
    const share = WS_METHODS.collaboratorShareThreadFork;
    const setAccess = WS_METHODS.collaboratorSetAccessFork;
    assert.strictEqual(yield* denied(manager, share), AuthOrchestrationReadScope);
    assert.strictEqual(yield* denied(reader, share), AuthOrchestrationOperateScope);
    assert.strictEqual(yield* denied(reader, setAccess), AuthOrchestrationOperateScope);
    assert.isNull(yield* denied(host, share));
    assert.strictEqual(
      yield* denied(manager, WS_METHODS.colleagueInviteFork),
      AuthOrchestrationReadScope,
    );
    assert.strictEqual(
      yield* denied(reader, WS_METHODS.colleagueShareThreadFork),
      AuthOrchestrationOperateScope,
    );
    assert.isNull(yield* denied(host, WS_METHODS.colleagueInviteFork));
    assert.isNull(yield* denied(manager, WS_METHODS.collaboratorUnshareThreadFork));
  }),
);

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

        // The host's own sends cannot claim a collaborator wrote them; in a shared thread the
        // agent reads the host's name, and people see the host's own words.
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
        assert.deepStrictEqual(sentAuthor(ownerSent), { name: HOST, text: "hi", host: true });
        assert.isTrue(sentText(ownerSent).startsWith(`[${HOST}, the owner of this thread,`));
        assert.include(sentText(ownerSent), `${HOST} and Sam read it`);
        const ownerDispatch = (command: OrchestrationV2Command) =>
          owner["orchestration.dispatchCommand"](command, undefined as never);
        // An edit made under an older share list is re-attributed once, not nested.
        const stale = hostAttribution(HOST, ["Sam", "Kim"], "hi").text;
        const edited = yield* ownerDispatch(message(shared, "queued-run.edit", stale));
        assert.strictEqual(sentText(edited), sentText(ownerSent));
        assert.deepStrictEqual(sentAuthor(edited), { name: HOST, text: "hi", host: true });
        // A forced line never nests, and editing it without the flag judges it again.
        const forced = yield* ownerDispatch(
          message(shared, "message.dispatch", "hi", {
            version: 1,
            records: [],
            forceReplyFork: true,
          }),
        );
        assert.include(sentText(forced), "this message is for you: answer it");
        assert.notInclude(sentText(forced), "When the message is not for you");
        const unforced = yield* ownerDispatch(message(shared, "queued-run.edit", sentText(forced)));
        assert.strictEqual(sentText(unforced), sentText(ownerSent));
        // A native command reaches the provider as typed.
        const compact = yield* ownerDispatch(message(shared, "message.dispatch", "/compact"));
        assert.strictEqual(sentText(compact), "/compact");
        assert.isUndefined(sentAuthor(compact));
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
        // "Ask the agent" swaps the judging rule for a forced answer, same author and words.
        const forced = yield* dispatch(
          message(shared, "message.dispatch", "hi", {
            version: 1,
            records: [],
            forceReplyFork: true,
          }),
          undefined as never,
        );
        assert.include(sentText(forced), "this message is for you: answer it");
        assert.notInclude(sentText(forced), "When the message is not for you");
        assert.isTrue(sentText(forced).endsWith("]\n\nhi"));
        assert.deepStrictEqual(sentAuthor(forced), { name: "Sam", text: "hi" });
        const refused = yield* Effect.exit(dispatch(message(other), undefined as never));
        assert.isTrue(Exit.isFailure(refused));
        for (const type of [
          "run.interrupt",
          "runtime-request.respond",
          "thread.model-selection.set",
        ]) {
          assert.strictEqual(
            (yield* dispatch(message(shared, type), undefined as never)).type,
            type,
          );
        }
        for (const type of [
          "thread.archive",
          "thread.settle",
          "thread.runtime-mode.set",
          "queued-run.start",
          "queued-run.reorder",
          "queued-message.promote-to-steer",
        ]) {
          const hostOnly = yield* Effect.exit(dispatch(message(shared, type), undefined as never));
          assert.isTrue(Exit.isFailure(hostOnly));
        }
        // Their own queued message is theirs to remove or reword; an edit stays attributed.
        const queued = (type: string, runId: string, text = "hi") =>
          ({
            ...(message(shared, type, text) as object),
            runId,
          }) as never as OrchestrationV2Command;
        const cancelled = yield* dispatch(
          queued("queued-run.cancel", "run-sam"),
          undefined as never,
        );
        assert.strictEqual(cancelled.type, "queued-run.cancel");
        for (const text of ["hi", attributed]) {
          const edited = yield* dispatch(
            queued("queued-run.edit", "run-sam", text),
            undefined as never,
          );
          assert.strictEqual(sentText(edited), attributed);
          assert.deepStrictEqual(sentAuthor(edited), { name: "Sam", text: "hi" });
        }
        for (const runId of ["run-host", "run-pat", "run-missing"]) {
          for (const type of ["queued-run.cancel", "queued-run.edit"]) {
            const notTheirs = yield* Effect.exit(dispatch(queued(type, runId), undefined as never));
            assert.isTrue(Exit.isFailure(notTheirs));
          }
        }
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
        // Cited messages run long; one waits as long as the host could send it.
        const long = yield* decodeSubmitMessage({
          threadId: shared,
          text: "x".repeat(10_000),
        });
        yield* sam["collaborator.submitMessageFork"](long);
        assert.deepStrictEqual(
          (yield* waiting(host)).map(({ name, text }) => ({ name, text })),
          [
            { name: "Sam", text: "first" },
            { name: "Sam", text: long.text },
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
          [[collaboratorPrompt("Sam", "first"), { name: "Sam", text: "first", sentByHost: true }]],
        );
        // "Ask the agent" waits with the message; the host's send forces the answer.
        yield* sam["collaborator.submitMessageFork"]({
          threadId: shared,
          text: "thanks",
          forceReplyFork: true,
        });
        const [ask] = yield* waiting(host);
        assert.isTrue(ask!.forceReplyFork);
        yield* host["collaborator.resolveMessageFork"]({
          threadId: shared,
          messageId: ask!.id,
          decision: "send",
        });
        const forced = hostDispatches.at(-1)!;
        assert.strictEqual(sentText(forced), collaboratorAttribution("Sam", "thanks", true).text);
        assert.isTrue(sentContext(forced)?.forceReplyFork);

        // A dismissal stays with Sam, past a restart, until Sam clears it, and holds no slot.
        yield* sam["collaborator.submitMessageFork"]({ threadId: shared, text: "maybe" });
        const resolve = (handlers: typeof host, messageId: string, decision: "send" | "dismiss") =>
          handlers["collaborator.resolveMessageFork"]({ threadId: shared, messageId, decision });
        const [maybe] = yield* waiting(sam);
        yield* resolve(host, maybe!.id, "dismiss");
        assert.deepStrictEqual(yield* waiting(host), []);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(resolve(host, maybe!.id, "send"))));
        const restarted = yield* Effect.provide(
          Effect.flatMap(CollaboratorShares.CollaboratorSharesFork, (restarted) =>
            waiting(restarted.messageHandlers("colleague:sam")),
          ),
          CollaboratorShares.layer.pipe(Layer.provide(tunnelClient())),
        );
        assert.deepStrictEqual(
          restarted.map(({ text, outcome }) => ({ text, outcome })),
          [{ text: "maybe", outcome: "dismissed" }],
        );
        // A flush from Sam's queue that repeats after a lost reply waits once, and once sent
        // never waits again.
        const flushed = { threadId: shared, text: "queued offline", id: "outbox-1" };
        yield* sam["collaborator.submitMessageFork"](flushed);
        yield* sam["collaborator.submitMessageFork"](flushed);
        assert.deepStrictEqual(
          (yield* waiting(host)).map(({ id, text }) => ({ id, text })),
          [{ id: "outbox-1", text: "queued offline" }],
        );
        yield* resolve(host, "outbox-1", "send");
        yield* sam["collaborator.submitMessageFork"](flushed);
        assert.deepStrictEqual(yield* waiting(host), []);
        // A refused send never reached the thread and can never run under its id, so its retry
        // fails rather than waiting or counting as sent.
        rejectedReceipts.add("collaborator-message:outbox-2");
        const retry = sam["collaborator.submitMessageFork"]({ ...flushed, id: "outbox-2" });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(retry)));
        assert.deepStrictEqual(yield* waiting(host), []);
        for (const text of ["a", "b", "c"]) {
          yield* sam["collaborator.submitMessageFork"]({ threadId: shared, text });
        }
        for (const { id } of yield* waiting(sam)) yield* resolve(sam, id, "dismiss");
        assert.deepStrictEqual(yield* waiting(sam), []);
        assert.strictEqual(hostDispatches.length, 3);

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
        // Accepting an invite saves the host; the colleague RPCs that manage others stay out.
        assert.isTrue(yield* allowed(WS_METHODS.colleagueSaveFork));
        assert.isFalse(yield* allowed(WS_METHODS.colleagueInviteFork));
        assert.isTrue(yield* allowed(turnDiff, { threadId: shared }));
        assert.isFalse(yield* allowed(turnDiff, { threadId: other }));
        const typing = WS_METHODS.collaboratorSetTypingFork;
        assert.isTrue(yield* allowed(typing, { threadId: shared, typing: true }));
        assert.isFalse(yield* allowed(typing, { threadId: other, typing: true }));
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

  it.effect("a saved colleague reads every team project thread, and writes none", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      projectEvents.queue = yield* Queue.unbounded<object, Error>();
      const touch = (event: object) => Queue.offer(projectEvents.queue!, event);
      const marked = (on: boolean) =>
        (on
          ? sql`INSERT INTO fork_team_projects (project_id, marked_at) VALUES (${otherProject}, '')`
          : sql`DELETE FROM fork_team_projects WHERE project_id = ${otherProject}`
        ).pipe(Effect.andThen(touch({ aggregateKind: "project" })));
      yield* withService(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO fork_colleagues (subject, name, environment_id, url, secret_name, saved_at)
            VALUES ('colleague:alex', 'Alex', 'env-alex', 'http://alex', 'secret', '')
          `;
          const service = yield* CollaboratorShares.CollaboratorSharesFork;
          const viewClosed = yield* Deferred.make<void>();
          const alex = {
            ...handlers,
            "orchestration.subscribeThread": (
              input: { readonly afterSequence?: number | undefined },
              options: never,
            ) =>
              handlers["orchestration.subscribeThread"](input, options).pipe(
                Stream.ensuring(Deferred.succeed(viewClosed, undefined)),
              ),
          };
          Object.assign(alex, service.wrapHandlers("colleague:alex", alex));
          const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
          shellEvents.queue = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
          const fiber = yield* alex["orchestration.subscribeShell"]({}, undefined as never).pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.forkChild,
          );
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);

          // Marking opens the project's threads, read-only; the unmarked project stays hidden.
          yield* marked(true);
          const afterMark = yield* Queue.take(items);
          assert.deepStrictEqual(visibleThreads(afterMark), [other]);
          assert.deepStrictEqual(visibleProjects(afterMark), [otherProject]);
          assert.strictEqual(
            afterMark.kind === "snapshot" ? afterMark.snapshot.threads[0]?.collaboratorFork : null,
            "read",
          );
          // A thread started after marking arrives live.
          const later = { ...threadShell(other), id: ThreadId.make("later") };
          yield* Queue.offer(shellEvents.queue, { kind: "thread.updated", thread: later } as never);
          const arrived = yield* Queue.take(items);
          assert.strictEqual(arrived.kind === "thread.updated" && arrived.thread.id, later.id);
          assert.isTrue(yield* service.canRead("colleague:alex", other));
          assert.isFalse(yield* service.canRead("colleague:alex", shared));
          // A one-time guest with no saved colleague row reads no team thread.
          assert.isFalse(yield* service.canRead("colleague:pat", other));

          // Read-only on the server: every write to a team thread is refused.
          const dispatch = alex["orchestration.dispatchCommand"];
          for (const type of ["message.dispatch", "run.interrupt", "thread.archive"]) {
            const refused: { readonly message: string } = yield* Effect.flip(
              dispatch(message(other, type), undefined as never),
            );
            assert.strictEqual(
              refused.message,
              "Team project threads are read-only for colleagues.",
            );
          }
          const submit =
            service.messageHandlers("colleague:alex")["collaborator.submitMessageFork"];
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(submit({ threadId: other, text: "hi" }))),
          );
          const check = (method: string, payload: unknown) =>
            Effect.service(RpcScopeAuthorization).pipe(
              service.guardRpc("colleague:alex"),
              Effect.provideService(RpcScopeAuthorization, (effect) => effect),
              Effect.flatMap((authorize) =>
                Effect.exit(
                  authorize(Effect.void as never, { rpc: { _tag: method }, payload } as never),
                ),
              ),
              Effect.map(Exit.isSuccess),
              Effect.scoped,
            );
          assert.isTrue(yield* check(ORCHESTRATION_V2_WS_METHODS.getTurnItem, { threadId: other }));
          assert.isFalse(
            yield* check(ORCHESTRATION_V2_WS_METHODS.getTurnItem, { threadId: shared }),
          );
          assert.isFalse(
            yield* check(WS_METHODS.collaboratorSubmitMessageFork, { threadId: other }),
          );
          assert.isFalse(
            yield* check(WS_METHODS.collaboratorSetTypingFork, { threadId: other, typing: true }),
          );

          // A thread moving out of a team project closes its open view at once.
          const view = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          yield* alex["orchestration.subscribeThread"](
            { threadId: other } as never,
            undefined as never,
          ).pipe(
            Stream.runForEach((item) => Queue.offer(view, item)),
            Effect.forkChild,
          );
          yield* Queue.take(view);
          projectOf[other] = sharedProject;
          yield* touch({ event: { type: "thread.metadata-updated" } });
          yield* Deferred.await(viewClosed);
          projectOf[other] = otherProject;

          // Removing the colleague removes access, marked or not.
          yield* sql`DELETE FROM fork_colleagues WHERE subject = 'colleague:alex'`;
          assert.isFalse(yield* service.canRead("colleague:alex", other));
          yield* sql`
            INSERT INTO fork_colleagues (subject, name, environment_id, url, secret_name, saved_at)
            VALUES ('colleague:alex', 'Alex', 'env-alex', 'http://alex', 'secret', '')
          `;

          // Unmarking removes them at once.
          yield* marked(false);
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
          assert.isFalse(yield* service.canRead("colleague:alex", other));

          // A broken mark watcher fails closed: no team access until it reads fresh marks.
          yield* marked(true);
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), [other]);
          yield* Queue.fail(projectEvents.queue!, new Error("store gone"));
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
          assert.isFalse(yield* service.canRead("colleague:alex", other));
          yield* Fiber.interrupt(fiber);
          yield* sql`DELETE FROM fork_team_projects WHERE project_id = ${otherProject}`;
          yield* sql`DELETE FROM fork_colleagues WHERE subject = 'colleague:alex'`;
        }),
      );
      delete projectEvents.queue;
    }),
  );

  it.effect(
    "shows each viewer the others' drafts until they stop, go quiet, or lose the share",
    () =>
      withService(
        Effect.gen(function* () {
          const service = yield* CollaboratorShares.CollaboratorSharesFork;
          // Earlier tests left Ana sharing the thread.
          for (const subject of ["colleague:ana", "colleague:sam"]) {
            yield* service.unshare({ threadId: shared, subject });
          }
          const host = service.typingHandlers(null);
          const sam = service.typingHandlers("colleague:sam");
          const typing = (handlers: typeof host, on: boolean, draft?: CollaboratorDraftFork) =>
            handlers["collaborator.setTypingFork"]({
              threadId: shared,
              typing: on,
              ...(draft === undefined ? {} : { draft }),
            });
          const watch = Effect.fn(function* (handlers: typeof host) {
            const seen = yield* Queue.unbounded<unknown>();
            yield* handlers["collaborator.subscribeTypingFork"]({ threadId: shared }).pipe(
              Stream.runForEach((state) => Queue.offer(seen, state)),
              Effect.forkChild,
            );
            return seen;
          });
          // Everyone who ever joined the thread, in order, so each client colours them alike.
          // Earlier tests shared it with Sam, then Ana.
          const people = ["Sam", "Ana"];
          const idle = (shared: boolean) => ({
            shared,
            typists: [],
            ...(shared ? { people } : {}),
          });
          const samTyping = {
            shared: true,
            typists: [{ subject: "colleague:sam", name: "Sam" }],
            people,
          };
          const hostTyping = { shared: true, typists: [{ subject: "host" }], people };

          // Sharing and unsharing reach both sides with nobody typing.
          // Sam's own name rides along, so Sam's client can tell their sent messages apart.
          const asSam = <S extends object>(state: S) => ({ ...state, you: "Sam" });
          const hostSeen = yield* watch(host);
          assert.deepStrictEqual(yield* Queue.take(hostSeen), idle(false));
          yield* service.share({ threadId: shared, collaboratorName: "Sam" });
          assert.deepStrictEqual(yield* Queue.take(hostSeen), idle(true));
          const samSeen = yield* watch(sam);
          assert.deepStrictEqual(yield* Queue.take(samSeen), asSam(idle(true)));

          yield* typing(sam, true);
          yield* typing(host, true);
          assert.deepStrictEqual(yield* Queue.take(hostSeen), samTyping);
          assert.deepStrictEqual(yield* Queue.take(samSeen), asSam(hostTyping));

          // A heartbeat restarts the countdown; silence past it drops the typist with no call.
          yield* TestClock.adjust("4 seconds");
          yield* typing(sam, true);
          yield* TestClock.adjust("4 seconds");
          assert.deepStrictEqual(yield* Queue.take(samSeen), asSam(idle(true)));
          assert.strictEqual(yield* Queue.size(hostSeen), 0);
          yield* TestClock.adjust("1 second");
          assert.deepStrictEqual(yield* Queue.take(hostSeen), idle(true));

          yield* typing(host, true);
          assert.deepStrictEqual(yield* Queue.take(samSeen), asSam(hostTyping));
          yield* typing(host, false);
          assert.deepStrictEqual(yield* Queue.take(samSeen), asSam(idle(true)));

          // The host reads Sam's draft as it changes; a keepalive repeating it sends nothing.
          const draft = (text: string) => ({ text, truncated: false, chips: [] });
          const samWriting = (text: string) => ({
            shared: true,
            typists: [{ subject: "colleague:sam", name: "Sam", draft: draft(text) }],
            people,
          });
          yield* typing(sam, true, draft("Fix the"));
          assert.deepStrictEqual(yield* Queue.take(hostSeen), samWriting("Fix the"));
          yield* typing(sam, true, draft("Fix the"));
          assert.strictEqual(yield* Queue.size(hostSeen), 0);
          yield* typing(sam, true, draft("Fix the bug"));
          assert.deepStrictEqual(yield* Queue.take(hostSeen), samWriting("Fix the bug"));
          yield* typing(sam, false);
          assert.deepStrictEqual(yield* Queue.take(hostSeen), idle(true));

          // Each of the host's devices holds its own draft; one stopping leaves the other's.
          const onDevice = (device: string, text?: string) =>
            host["collaborator.setTypingFork"]({
              threadId: shared,
              device,
              ...(text === undefined ? { typing: false } : { typing: true, draft: draft(text) }),
            });
          const hostWriting = (...devices: ReadonlyArray<[string, string]>) => ({
            shared: true,
            typists: devices.map(([device, text]) => ({
              subject: "host",
              draft: draft(text),
              device,
            })),
            people,
          });
          yield* onDevice("laptop", "Ship it");
          assert.deepStrictEqual(
            yield* Queue.take(samSeen),
            asSam(hostWriting(["laptop", "Ship it"])),
          );
          yield* onDevice("desk", "Wait");
          assert.deepStrictEqual(
            yield* Queue.take(samSeen),
            asSam(hostWriting(["laptop", "Ship it"], ["desk", "Wait"])),
          );
          yield* onDevice("desk");
          assert.deepStrictEqual(
            yield* Queue.take(samSeen),
            asSam(hostWriting(["laptop", "Ship it"])),
          );
          yield* onDevice("laptop");
          assert.deepStrictEqual(yield* Queue.take(samSeen), asSam(idle(true)));
          const overCap = decodeSetTyping({
            threadId: shared,
            typing: true,
            draft: draft("x".repeat(COLLABORATOR_DRAFT_TEXT_MAX_CHARS + 1)),
          });
          assert.isTrue(Exit.isFailure(overCap));

          yield* service.unshare({ threadId: shared, subject: "colleague:sam" });
          assert.deepStrictEqual(yield* Queue.take(hostSeen), idle(false));
          assert.deepStrictEqual(yield* Queue.take(samSeen), asSam(idle(false)));
          assert.isTrue(Exit.isFailure(yield* Effect.exit(typing(sam, true))));

          // Unsharing drops Sam's typing, so a re-share within the heartbeat shows nobody.
          yield* service.share({ threadId: shared, collaboratorName: "Sam" });
          yield* typing(sam, true);
          yield* service.unshare({ threadId: shared, subject: "colleague:sam" });
          yield* service.share({ threadId: shared, collaboratorName: "Sam" });
          const again = yield* host["collaborator.subscribeTypingFork"]({ threadId: shared }).pipe(
            Stream.runHead,
          );
          assert.deepStrictEqual(Option.getOrThrow(again), idle(true));

          // Typing "sam" for another thread reaches the same person, who stays "Sam".
          const typedLower = yield* service.share({ threadId: other, collaboratorName: "sam" });
          assert.strictEqual(typedLower.collaboratorName, "Sam");
          assert.strictEqual(pairingLabels.at(-1), "Collaborator Sam");
          const renamed = yield* sam["collaborator.subscribeTypingFork"]({ threadId: shared }).pipe(
            Stream.runHead,
          );
          assert.deepStrictEqual(Option.getOrThrow(renamed), asSam(idle(true)));
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
