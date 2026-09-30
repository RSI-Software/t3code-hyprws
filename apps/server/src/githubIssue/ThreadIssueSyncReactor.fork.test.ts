import {
  EventId,
  GitHubIssueOperationError,
  ProjectId,
  ThreadId,
  type GitHubIssueRef,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerActivation } from "../serverActivation.ts";
import { GitHubIssueService } from "./GitHubIssueService.ts";
import type { GitHubIssueSummary } from "./gitHubIssueJson.ts";
import * as ThreadIssueSyncReactor from "./ThreadIssueSyncReactor.fork.ts";

const NOW = "2026-09-30T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("issue-sync-project");

type SyncCommand = Extract<OrchestrationCommand, { readonly type: "thread.issue-link.sync" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeLink(number: number, syncedAt: string | null = null): ThreadIssueLink {
  return {
    host: "github.com",
    repository: "acme/web",
    number,
    url: `https://github.com/acme/web/issues/${number}`,
    source: "manual",
    linkedAt: "2026-09-01T00:00:00.000Z",
    snapshot: syncedAt === null ? null : { title: "Old title", state: "open", syncedAt },
  };
}

function makeThread(id: string, issues: ReadonlyArray<ThreadIssueLink>) {
  return { id: ThreadId.make(id), projectId: PROJECT_ID, issues };
}

function makeSummary(input: GitHubIssueRef): GitHubIssueSummary {
  return { title: `Issue ${input.number}`, state: "closed", closeReason: "not planned" };
}

const makeHarness = Effect.fn("makeThreadIssueSyncHarness")(function* (
  summary: (
    input: GitHubIssueRef,
  ) => Effect.Effect<GitHubIssueSummary, GitHubIssueOperationError> = (input) =>
    Effect.succeed(makeSummary(input)),
) {
  const activation = yield* Deferred.make<void>();
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const reads = yield* Ref.make<ReadonlyArray<GitHubIssueRef>>([]);
  const syncs = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const started = yield* Queue.unbounded<void>();
  const shell = makeThread("linked", []) as unknown as OrchestrationThreadShell;

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeed(Option.some(shell)),
    }),
    // Only the light read is implemented: a sync that reached for the full detail would fail.
    Layer.mock(GitHubIssueService)({
      summary: (input) =>
        Ref.update(reads, (all) => [...all, input]).pipe(
          Effect.andThen(Queue.offer(started, undefined)),
          Effect.andThen(summary(input)),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        command.type === "thread.issue-link.sync"
          ? Ref.update(syncs, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 }))
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  const context = yield* Layer.build(
    ThreadIssueSyncReactor.layer.pipe(Layer.provide(dependencies)),
  );
  yield* Deferred.succeed(activation, undefined);
  const reactor = Context.get(context, ThreadIssueSyncReactor.ThreadIssueSyncReactor);
  return { events, reads, syncs, started, reactor };
});

const linkedEvent = (link: ThreadIssueLink): OrchestrationEvent => ({
  type: "thread.issue-linked",
  sequence: 2,
  eventId: EventId.make("issue-linked"),
  aggregateKind: "thread",
  aggregateId: ThreadId.make("linked"),
  occurredAt: NOW,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: { threadId: ThreadId.make("linked"), link, updatedAt: NOW },
});

describe("ThreadIssueSyncReactor", () => {
  it.effect("reads a live link at once, and nothing at boot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness();
        yield* fixture.reactor.drain;
        assert.lengthOf(yield* Ref.get(fixture.reads), 0);

        yield* PubSub.publish(fixture.events, linkedEvent(makeLink(7)));
        // The event is consumed on its own fiber; wait for its read, then for the worker.
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;

        const [sync] = yield* Ref.get(fixture.syncs);
        assert.deepStrictEqual(sync?.snapshot, {
          title: "Issue 7",
          state: "closed",
          closeReason: "not planned",
          syncedAt: NOW,
        });
      }),
    ),
  );

  it.effect("a panel opening rereads only stale links; a refresh rereads every link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness();
        const thread = makeThread("one", [
          makeLink(1),
          makeLink(2, "2026-09-30T11:59:00.000Z"),
          makeLink(3, "2026-09-30T11:00:00.000Z"),
        ]);

        yield* fixture.reactor.syncThread(thread, "stale");
        yield* fixture.reactor.drain;
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.reads)).map((read) => read.number).toSorted(),
          [1, 3],
        );

        yield* Ref.set(fixture.reads, []);
        yield* fixture.reactor.syncThread(thread, "all");
        yield* fixture.reactor.drain;
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.reads)).map((read) => read.number).toSorted(),
          [1, 2, 3],
        );
      }),
    ),
  );

  it.effect("one issue linked from two threads is read once and synced to both", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const gate = yield* Deferred.make<void>();
        const fixture = yield* makeHarness((input) =>
          Deferred.await(gate).pipe(Effect.as(makeSummary(input))),
        );
        yield* fixture.reactor.syncThread(makeThread("one", [makeLink(9)]), "all");
        // The second request lands while the first read is in flight and joins it.
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.syncThread(makeThread("two", [makeLink(9)]), "all");
        yield* Deferred.succeed(gate, undefined);
        yield* fixture.reactor.drain;

        assert.lengthOf(yield* Ref.get(fixture.reads), 1);
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.syncs)).map((sync) => sync.threadId).toSorted(),
          ["one", "two"],
        );
      }),
    ),
  );

  it.effect("caps concurrent host reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const running = yield* Ref.make(0);
        const peak = yield* Ref.make(0);
        const fixture = yield* makeHarness((input) =>
          Ref.updateAndGet(running, (count) => count + 1).pipe(
            Effect.flatMap((count) => Ref.update(peak, (max) => Math.max(max, count))),
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(Ref.update(running, (count) => count - 1)),
            Effect.as(makeSummary(input)),
          ),
        );
        const links = Array.from({ length: 10 }, (_, index) => makeLink(index + 1));
        yield* fixture.reactor.syncThread(makeThread("one", links), "all");
        yield* Queue.takeN(fixture.started, ThreadIssueSyncReactor.THREAD_ISSUE_READ_CONCURRENCY);
        yield* Deferred.succeed(gate, undefined);
        yield* fixture.reactor.drain;

        assert.lengthOf(yield* Ref.get(fixture.reads), 10);
        assert.strictEqual(
          yield* Ref.get(peak),
          ThreadIssueSyncReactor.THREAD_ISSUE_READ_CONCURRENCY,
        );
      }),
    ),
  );

  it.effect("a failed read writes nothing, so state stays unknown or keeps its last read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness(() =>
          Effect.fail(new GitHubIssueOperationError({ operation: "detail", detail: "offline" })),
        );
        yield* fixture.reactor.syncThread(
          makeThread("one", [makeLink(1), makeLink(2, "2026-09-01T00:00:00.000Z")]),
          "all",
        );
        yield* fixture.reactor.drain;

        assert.lengthOf(yield* Ref.get(fixture.reads), 2);
        assert.lengthOf(yield* Ref.get(fixture.syncs), 0);
      }),
    ),
  );

  it.effect("a sync carries its read's start time, so a link made mid-read rejects it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const gate = yield* Deferred.make<void>();
        const fixture = yield* makeHarness((input) =>
          Deferred.await(gate).pipe(Effect.as(makeSummary(input))),
        );
        yield* fixture.reactor.syncThread(makeThread("one", [makeLink(4)]), "all");
        yield* Queue.take(fixture.started);
        yield* TestClock.adjust("1 minute");
        // Relinked after the read began: it waits for a read of its own.
        yield* fixture.reactor.syncThread(
          makeThread("two", [{ ...makeLink(4), linkedAt: "2026-09-30T12:00:30.000Z" }]),
          "all",
        );
        yield* Deferred.succeed(gate, undefined);
        yield* fixture.reactor.drain;

        const syncs = yield* Ref.get(fixture.syncs);
        assert.deepStrictEqual(
          syncs.map((sync) => [sync.threadId, sync.snapshot.syncedAt]),
          [
            ["one", NOW],
            ["two", "2026-09-30T12:01:00.000Z"],
          ],
        );
      }),
    ),
  );
});
