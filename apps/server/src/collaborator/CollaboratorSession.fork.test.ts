import { assert } from "@effect/vitest";
import {
  COLLABORATOR_DRAFT_TEXT_MAX_CHARS,
  type CollaboratorDraftFork,
  EnvironmentAuthenticatedPrincipal,
  type OrchestrationV2Command,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadStreamItem,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { collaboratorAttribution, hostAttribution } from "./CollaboratorMessages.fork.ts";
import * as CollaboratorShares from "./CollaboratorShares.fork.ts";
import {
  HOST,
  database,
  decodeSetTyping,
  decodeSubmitMessage,
  hostDispatches,
  other,
  otherProject,
  pairedSubjects,
  pairingLabels,
  projectEvents,
  projectOf,
  rejectedReceipts,
  shared,
  sharedProject,
  threadShell,
  tunnelClient,
  withService,
} from "./CollaboratorShares.fork.testFixtures.ts";

/** Sam as someone already shared with, so every test reaches the same person. */
const shareSam = (
  service: CollaboratorShares.CollaboratorSharesFork["Service"],
  threadId: string,
  access?: "send" | "approve",
) => service.shareWith({ threadId, subject: "colleague:sam", name: "Sam", access });

const collaboratorPrompt = (name: string, text: string) =>
  collaboratorAttribution({ name, subject: "colleague:sam" }, text).text;

// `outputAfterRevoke` supplies command output.
const commandOutput: { queue?: Queue.Queue<OrchestrationV2CommandOutputFrame, Cause.Done> } = {};

/** Opens command output, revokes access, and counts the frames that still reach the collaborator. */
const outputAfterRevoke = Effect.fnUntraced(function* <OE, E, R>(
  open: (input: never, options: never) => Stream.Stream<OrchestrationV2CommandOutputFrame, OE>,
  threadId: string,
  revoke: Effect.Effect<unknown, E, R>,
) {
  const source = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame, Cause.Done>();
  commandOutput.queue = source;
  const received = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
  const fiber = yield* open({ threadId } as never, undefined as never).pipe(
    Stream.runForEach((frame) => Queue.offer(received, frame)),
    Effect.forkChild,
  );
  const frame = (text: string) =>
    ({ kind: "append", text, truncated: false, running: true }) as const;
  yield* Queue.offer(source, frame("before"));
  assert.strictEqual((yield* Queue.take(received)).text, "before");
  yield* revoke;
  yield* Queue.offer(source, frame("after"));
  yield* Queue.end(source);
  yield* Fiber.join(fiber);
  delete commandOutput.queue;
  return yield* Queue.size(received);
});

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

// The host's archive: the hand-shared thread, the team thread, and one in a third project.
const hidden = ThreadId.make("hidden");
const hiddenProject = ProjectId.make("p-hidden");
const archivedShell = (id: ThreadId, projectId = projectOf[id]!) => ({
  ...threadShell(shared),
  id,
  projectId,
  archivedAt: threadShell(shared).createdAt,
});
const archive = () => ({
  schemaVersion: 1,
  snapshotSequence: 3,
  projects: [sharedProject, otherProject, hiddenProject].map((id) => ({ id })) as never,
  threads: [archivedShell(shared), archivedShell(other), archivedShell(hidden, hiddenProject)],
});

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
  "orchestration.getArchivedShellSnapshot": (_input: object, _options: never) =>
    Effect.succeed(archive()),
  "orchestration.subscribeCommandOutput": (_input: object, _options: never) =>
    commandOutput.queue ? Stream.fromQueue(commandOutput.queue) : Stream.never,
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

database("CollaboratorSessionFork", (it) => {
  const replyEdit = (threadId: ThreadId, runId: string) =>
    Effect.flatMap(CollaboratorShares.CollaboratorSharesFork, (service) =>
      service
        .wrapHandlers("owner", handlers)
        ["orchestration.dispatchCommand"](
          { ...(message(threadId, "queued-run.edit", "Sure, 4 works.") as object), runId } as never,
          undefined as never,
        ),
    );

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
        yield* shareSam(service, shared);
        const afterShare = yield* Queue.take(items);
        assert.deepStrictEqual(visibleThreads(afterShare), [shared]);
        assert.deepStrictEqual(visibleProjects(afterShare), [sharedProject]);
        // A project metadata refresh carries no threads; it keeps the visible projects, and
        // names no hidden project's root.
        yield* Queue.offer(shellEvents.queue, {
          ...snapshot(),
          snapshot: {
            threads: [],
            archivedThreads: [],
            projects: [
              { id: sharedProject, workspaceRoot: "/shared" },
              { id: otherProject, workspaceRoot: "/other" },
            ],
          },
          resolvedRepositoryIdentityRoots: ["/shared", "/other"],
        } as never);
        const refresh = yield* Queue.take(items);
        assert.deepStrictEqual(visibleProjects(refresh), [sharedProject]);
        assert.deepStrictEqual(
          refresh.kind === "snapshot" ? refresh.resolvedRepositoryIdentityRoots : undefined,
          ["/shared"],
        );
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
        yield* shareSam(service, shared);
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
        // Editing a queued reply keeps the waiting message it answers, even with no share left.
        for (const threadId of [shared, other]) {
          const edited = yield* replyEdit(threadId, "run-reply");
          assert.include(sentText(edited), `in reply to this message Sam wrote to the owner`);
          assert.deepStrictEqual(sentAuthor(edited), {
            name: HOST,
            text: "Sure, 4 works.",
            host: true,
            replyTo: { name: "Sam", text: "pair at 3?" },
          });
        }
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

  it.effect("refuses a queued edit whose reply it cannot read, rather than drop the quote", () =>
    withService(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(replyEdit(shared, "run-unreadable"));
        assert.isTrue(Exit.isFailure(exit));
      }),
    ),
  );

  it.effect("limits a collaborator to shared threads and names them in their messages", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* CollaboratorShares.CollaboratorSharesFork;
        yield* shareSam(service, shared, "send");
        // Picking Sam again mints them a link for another device, under their own grant.
        const result = yield* service.share({
          threadId: shared,
          collaboratorName: "Sam",
          subject: "colleague:sam",
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
        assert.deepStrictEqual(sentAuthor(sent), {
          name: "Sam",
          subject: "colleague:sam",
          text: "hi",
        });
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
        assert.deepStrictEqual(sentAuthor(forced), {
          name: "Sam",
          subject: "colleague:sam",
          text: "hi",
        });
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
        // A message may not complete a plan, or name a sender, on a thread not shared to them.
        for (const fields of [
          { sourcePlanRef: { threadId: other, planId: "plan" } },
          { senderThreadId: other },
        ]) {
          const named = { ...(message(shared) as object), ...fields } as never;
          assert.isTrue(Exit.isFailure(yield* Effect.exit(dispatch(named, undefined as never))));
        }
        const ownPlan = {
          ...(message(shared) as object),
          sourcePlanRef: { threadId: shared, planId: "plan" },
        } as never as OrchestrationV2Command;
        assert.strictEqual((yield* dispatch(ownPlan, undefined as never)).type, "message.dispatch");
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
        // Their own queued message is theirs to remove or reword, under any label; an edit stays
        // attributed to them.
        const queued = (type: string, runId: string, text = "hi") =>
          ({
            ...(message(shared, type, text) as object),
            runId,
          }) as never as OrchestrationV2Command;
        for (const runId of ["run-sam", "run-sam-machine"]) {
          const cancelled = yield* dispatch(queued("queued-run.cancel", runId), undefined as never);
          assert.strictEqual(cancelled.type, "queued-run.cancel");
        }
        for (const text of ["hi", attributed]) {
          const edited = yield* dispatch(
            queued("queued-run.edit", "run-sam", text),
            undefined as never,
          );
          assert.strictEqual(sentText(edited), attributed);
          assert.deepStrictEqual(sentAuthor(edited), {
            name: "Sam",
            subject: "colleague:sam",
            text: "hi",
          });
        }
        // A namesake's line is not theirs, and a line with no stored author stays the host's.
        for (const runId of [
          "run-host",
          "run-pat",
          "run-sam-namesake",
          "run-sam-legacy",
          "run-missing",
        ]) {
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
        // refused, its command output ends, and a re-share resumes after sequence 4.
        assert.strictEqual(
          yield* outputAfterRevoke(
            wrapped["orchestration.subscribeCommandOutput"],
            shared,
            service.unshare({ threadId: shared, subject: "colleague:sam" }),
          ),
          0,
        );
        assert.deepStrictEqual(yield* Queue.take(live), { kind: "synchronized" });
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(dispatch(message(shared), undefined as never))),
        );
        const stopped = yield* service.threadShares(shared);
        assert.deepStrictEqual(stopped.sharedWith, []);
        assert.deepStrictEqual(stopped.collaborators, [{ subject: "colleague:sam", name: "Sam" }]);
        // A re-share keeps the access it had.
        yield* shareSam(service, shared);
        assert.deepStrictEqual((yield* service.threadShares(shared)).sharedWith, [
          { subject: "colleague:sam", name: "Sam", access: "send" },
        ]);
        yield* Queue.take(live);
        assert.deepStrictEqual(threadInputs, [undefined, 4]);
        yield* Fiber.interrupt(open);

        pairedSubjects.add("colleague:sam");
        const again = yield* service.share({
          threadId: shared,
          collaboratorName: "Sam",
          subject: "colleague:sam",
        });
        assert.isTrue(again.knownCollaborator);
      }),
    ),
  );

  it.effect("holds an approve collaborator's messages until the host sends them", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* CollaboratorShares.CollaboratorSharesFork;
        // The database is shared across tests, where Sam was given send access.
        yield* shareSam(service, shared, "approve");
        yield* service.shareWith({ threadId: shared, subject: "colleague:ana", name: "Ana" });
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
        // A share naming no access, as a saved colleague's is, needs approval too.
        const ana = { ...handlers };
        Object.assign(ana, service.wrapHandlers("colleague:ana", ana));
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              ana["orchestration.dispatchCommand"](message(shared), undefined as never),
            ),
          ),
        );
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
          [
            [
              collaboratorPrompt("Sam", "first"),
              { name: "Sam", subject: "colleague:sam", text: "first", sentByHost: true },
            ],
          ],
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
        assert.strictEqual(
          sentText(forced),
          collaboratorAttribution({ name: "Sam", subject: "colleague:sam" }, "thanks", true).text,
        );
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
        // A reply goes into the thread as the host's line to Sam, which the agent may stay quiet on.
        yield* sam["collaborator.submitMessageFork"]({ threadId: shared, text: "pair at 3?" });
        const [request] = yield* waiting(sam);
        const reply = (handlers: typeof host) =>
          handlers["collaborator.resolveMessageFork"]({
            threadId: shared,
            messageId: request!.id,
            decision: "reply",
            text: "Sure, 3 works.",
          });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(reply(sam))));
        yield* reply(host);
        assert.deepStrictEqual(yield* waiting(sam), []);
        const replied = hostDispatches.at(-1)!;
        assert.include(sentText(replied), `${HOST}, the owner of this thread, wrote the message`);
        assert.include(
          sentText(replied),
          `in reply to this message Sam wrote to the owner, which you were not sent: "pair at 3?"`,
        );
        assert.deepStrictEqual(sentAuthor(replied), {
          name: HOST,
          text: "Sure, 3 works.",
          host: true,
          replyTo: { name: "Sam", text: "pair at 3?" },
        });

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
        yield* shareSam(service, shared);
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

  it.effect("a saved colleague reads every team project thread, and asks the host to send", () =>
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
          // Each script plays in order, so a step runs only after the frame before it is gated.
          const scripts = yield* Queue.unbounded<Stream.Stream<OrchestrationV2ThreadStreamItem>>();
          const item = (sequence: number) =>
            ({ kind: "event", sequence }) as never as OrchestrationV2ThreadStreamItem;
          const frame = (sequence: number) => Stream.make(item(sequence));
          const step = (run: () => void) => Stream.fromEffect(Effect.sync(run)).pipe(Stream.drain);
          const alex = {
            ...handlers,
            "orchestration.subscribeThread": (_input: object, _options: never) =>
              Stream.fromQueue(scripts).pipe(
                Stream.flatMap((script) => script),
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

          // Marking opens the project's threads for approval; the unmarked project stays hidden.
          yield* marked(true);
          const afterMark = yield* Queue.take(items);
          assert.deepStrictEqual(visibleThreads(afterMark), [other]);
          assert.deepStrictEqual(visibleProjects(afterMark), [otherProject]);
          assert.strictEqual(
            afterMark.kind === "snapshot" ? afterMark.snapshot.threads[0]?.collaboratorFork : null,
            "approve",
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

          // No write reaches a team thread directly; a request waits for the host, with Alex's name.
          const dispatch = alex["orchestration.dispatchCommand"];
          for (const type of ["message.dispatch", "run.interrupt", "thread.archive"]) {
            const refused: { readonly message: string } = yield* Effect.flip(
              dispatch(message(other, type), undefined as never),
            );
            assert.strictEqual(
              refused.message,
              "The host approves your messages before they run. Send them from the composer.",
            );
          }
          const asks = service.messageHandlers("colleague:alex");
          const host = service.messageHandlers(null);
          const waiting = (handlers: typeof host) =>
            handlers["collaborator.subscribeMessagesFork"]().pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
          yield* asks["collaborator.submitMessageFork"]({ threadId: other, text: "hi" });
          const [request] = yield* waiting(host);
          assert.deepStrictEqual([request?.name, request?.text], ["Alex", "hi"]);
          assert.strictEqual((yield* waiting(asks)).length, 1);
          // Unmarking hides the request from the host, and marking again brings it back.
          const hostView = yield* Queue.unbounded<number>();
          const watching = yield* host["collaborator.subscribeMessagesFork"]().pipe(
            Stream.runForEach((list) => Queue.offer(hostView, list.length)),
            Effect.forkChild,
          );
          assert.strictEqual(yield* Queue.take(hostView), 1);
          yield* marked(false);
          assert.strictEqual(yield* Queue.take(hostView), 0);
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
          yield* marked(true);
          assert.strictEqual(yield* Queue.take(hostView), 1);
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), [other]);
          yield* Fiber.interrupt(watching);
          hostDispatches.length = 0;
          yield* host["collaborator.resolveMessageFork"]({
            threadId: other,
            messageId: request!.id,
            decision: "send",
          });
          assert.deepStrictEqual(sentAuthor(hostDispatches[0]!), {
            name: "Alex",
            subject: "colleague:alex",
            text: "hi",
            sentByHost: true,
          });
          // A reply on a team thread names Alex to the agent, though no hand share lists them.
          yield* asks["collaborator.submitMessageFork"]({ threadId: other, text: "lunch?" });
          const [ask] = yield* waiting(host);
          yield* host["collaborator.resolveMessageFork"]({
            threadId: other,
            messageId: ask!.id,
            decision: "reply",
            text: "After this.",
          });
          assert.include(sentText(hostDispatches.at(-1)!), `shared: ${HOST} and Alex read it`);
          // Editing a queued reply there keeps what it answers, with no hand share either.
          const owner = service.wrapHandlers("owner", handlers);
          const replyEdit = yield* owner["orchestration.dispatchCommand"](
            {
              ...(message(other, "queued-run.edit", "Later.") as object),
              runId: "run-reply",
            } as never,
            undefined as never,
          );
          assert.include(sentText(replyEdit), `in reply to this message Sam wrote to the owner`);
          assert.include(sentText(replyEdit), `shared: ${HOST} and Sam read it`);
          // A one-time guest asks nothing on a team thread.
          const pat = service.messageHandlers("colleague:pat")["collaborator.submitMessageFork"];
          assert.isTrue(Exit.isFailure(yield* Effect.exit(pat({ threadId: other, text: "hi" }))));
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
          assert.isTrue(
            yield* check(WS_METHODS.collaboratorSubmitMessageFork, { threadId: other }),
          );
          assert.isFalse(
            yield* check(WS_METHODS.collaboratorSetTypingFork, { threadId: other, typing: true }),
          );

          // A thread moving out of a team project closes its open view, and no frame leaves
          // between the move and the recheck.
          const view = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          yield* alex["orchestration.subscribeThread"](
            { threadId: other } as never,
            undefined as never,
          ).pipe(
            Stream.runForEach((item) => Queue.offer(view, item)),
            Effect.forkChild,
          );
          yield* Queue.offer(scripts, frame(4));
          assert.deepStrictEqual(yield* Queue.take(view), item(4));
          yield* Queue.offer(
            scripts,
            step(() => (projectOf[other] = sharedProject)).pipe(
              Stream.concat(frame(5)),
              Stream.concat(step(() => (projectOf[other] = otherProject))),
              Stream.concat(frame(6)),
            ),
          );
          assert.deepStrictEqual(yield* Queue.take(view), item(6));
          projectOf[other] = sharedProject;
          yield* touch({ event: { type: "thread.metadata-updated" } });
          yield* Deferred.await(viewClosed);
          projectOf[other] = otherProject;

          // An unmark hides the project and thread from the next shell items and ends the
          // thread's command output, before the marks refresh.
          assert.strictEqual(
            yield* outputAfterRevoke(
              alex["orchestration.subscribeCommandOutput"],
              other,
              sql`DELETE FROM fork_team_projects WHERE project_id = ${otherProject}`,
            ),
            0,
          );
          yield* Queue.offer(shellEvents.queue, {
            kind: "project.updated",
            project: { id: otherProject },
          } as never);
          yield* Queue.offer(shellEvents.queue, {
            kind: "thread.updated",
            thread: threadShell(other),
          } as never);
          assert.strictEqual((yield* Queue.take(items)).kind, "thread.removed");
          yield* sql`INSERT INTO fork_team_projects (project_id, marked_at) VALUES (${otherProject}, '')`;

          // Forgetting the colleague removes access, and saving them again restores it live.
          const saved = (on: boolean) =>
            (on
              ? sql`
                  INSERT INTO fork_colleagues
                    (subject, name, environment_id, url, secret_name, saved_at)
                  VALUES ('colleague:alex', 'Alex', 'env-alex', 'http://alex', 'secret', '')
                `
              : sql`DELETE FROM fork_colleagues WHERE subject = 'colleague:alex'`
            ).pipe(Effect.andThen(service.colleaguesChanged));
          yield* saved(false);
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
          assert.isFalse(yield* service.canRead("colleague:alex", other));
          yield* saved(true);
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), [other]);

          // Unmarking removes them at once.
          yield* marked(false);
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
          assert.isFalse(yield* service.canRead("colleague:alex", other));

          // A broken mark watcher fails closed: the list shows no team thread until it reads fresh marks.
          yield* marked(true);
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), [other]);
          yield* Queue.fail(projectEvents.queue!, new Error("store gone"));
          assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
          yield* Fiber.interrupt(fiber);
          yield* sql`DELETE FROM fork_team_projects WHERE project_id = ${otherProject}`;
          yield* sql`DELETE FROM fork_colleagues WHERE subject = 'colleague:alex'`;
        }),
      );
      delete projectEvents.queue;
    }),
  );

  it.effect("a collaborator's archive lists only the archived threads they read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* withService(
        Effect.gen(function* () {
          const service = yield* CollaboratorShares.CollaboratorSharesFork;
          yield* service.shareWith({ threadId: shared, subject: "colleague:alex", name: "Alex" });
          yield* sql`
            INSERT INTO fork_colleagues (subject, name, environment_id, url, secret_name, saved_at)
            VALUES ('colleague:alex', 'Alex', 'env-alex', 'http://alex', 'secret', '')
          `;
          yield* sql`INSERT INTO fork_team_projects (project_id, marked_at) VALUES (${otherProject}, '')`;
          const archived = Effect.fnUntraced(function* (subject: string) {
            const read = service.wrapHandlers(subject, handlers);
            const { threads, projects } = yield* read["orchestration.getArchivedShellSnapshot"](
              {},
              undefined as never,
            );
            return {
              threads: threads.map(({ id, collaboratorFork }) => [id, collaboratorFork]),
              projects: projects.map(({ id }) => id),
            };
          });
          const allowed = Effect.service(RpcScopeAuthorization).pipe(
            service.guardRpc("colleague:alex"),
            Effect.provideService(RpcScopeAuthorization, (effect) => effect),
            Effect.flatMap((authorize) =>
              Effect.exit(
                authorize(
                  Effect.void as never,
                  {
                    rpc: { _tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot },
                    payload: {},
                  } as never,
                ),
              ),
            ),
            Effect.map(Exit.isSuccess),
            Effect.scoped,
          );
          assert.isTrue(yield* allowed);

          // The hand share keeps its access, the team thread takes requests, the third stays hidden.
          assert.deepStrictEqual(yield* archived("colleague:alex"), {
            threads: [
              [shared, "approve"],
              [other, "approve"],
            ],
            projects: [sharedProject, otherProject],
          });
          // A one-time guest reads only what was shared with them by hand: here, nothing.
          assert.deepStrictEqual(yield* archived("colleague:pat"), { threads: [], projects: [] });
          // The host's archive is untouched.
          const host = yield* service
            .wrapHandlers("owner", handlers)
            ["orchestration.getArchivedShellSnapshot"]({}, undefined as never);
          assert.deepStrictEqual(
            host.threads.map(({ id }) => id),
            [shared, other, hidden],
          );
          yield* sql`DELETE FROM fork_colleague_shares WHERE subject = 'colleague:alex'`;
          yield* sql`DELETE FROM fork_team_projects WHERE project_id = ${otherProject}`;
          yield* sql`DELETE FROM fork_colleagues WHERE subject = 'colleague:alex'`;
        }),
      );
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
          const asSam = <S extends object>(state: S) => ({
            ...state,
            you: "Sam",
            yourSubject: "colleague:sam",
          });
          const hostSeen = yield* watch(host);
          assert.deepStrictEqual(yield* Queue.take(hostSeen), idle(false));
          yield* shareSam(service, shared);
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
          yield* shareSam(service, shared);
          yield* typing(sam, true);
          yield* service.unshare({ threadId: shared, subject: "colleague:sam" });
          yield* shareSam(service, shared);
          const again = yield* host["collaborator.subscribeTypingFork"]({ threadId: shared }).pipe(
            Stream.runHead,
          );
          assert.deepStrictEqual(Option.getOrThrow(again), idle(true));

          // Picking Sam for another thread reaches the same person, who stays "Sam".
          const typedLower = yield* service.share({
            threadId: other,
            collaboratorName: "sam",
            subject: "colleague:sam",
          });
          assert.strictEqual(typedLower.collaboratorName, "Sam");
          assert.strictEqual(pairingLabels.at(-1), "Collaborator Sam");
          const renamed = yield* sam["collaborator.subscribeTypingFork"]({ threadId: shared }).pipe(
            Stream.runHead,
          );
          assert.deepStrictEqual(Option.getOrThrow(renamed), asSam(idle(true)));
        }),
      ),
  );

  it.effect("a typed name is a new person; only picking someone reaches their grant", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* CollaboratorShares.CollaboratorSharesFork;
        yield* shareSam(service, other);
        pairedSubjects.add("colleague:sam");
        const picked = yield* service.share({
          threadId: other,
          collaboratorName: "Sam",
          subject: "colleague:sam",
        });
        assert.isTrue(picked.knownCollaborator);
        assert.deepStrictEqual((yield* service.threadShares(other)).sharedWith.length, 1);
        const newSams: Array<string | undefined> = [];
        for (const _ of [1, 2]) {
          const typed = yield* service.share({ threadId: other, collaboratorName: "Sam" });
          assert.isFalse(typed.knownCollaborator);
          newSams.push((yield* service.threadShares(other)).sharedWith.at(-1)?.subject);
        }
        assert.strictEqual(new Set(["colleague:sam", ...newSams]).size, 3);
        assert.isFalse(service.isShared(newSams[0] ?? "", shared));
        // Picking a subject nobody was shared with mints no grant under it.
        yield* service.share({
          threadId: other,
          collaboratorName: "Pat",
          subject: "colleague:pat",
        });
        assert.isFalse(service.isShared("colleague:pat", other));
      }),
    ),
  );
});
