import {
  EventId,
  GitHubIssueOperationError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ThreadIssueKey,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerActivation } from "../serverActivation.ts";
import { GitHubIssueService } from "./GitHubIssueService.ts";
import type { GitHubIssueSummary } from "./gitHubIssueJson.ts";
import * as ThreadIssueSyncReactor from "./ThreadIssueSyncReactor.fork.ts";

const NOW = "2026-09-30T12:00:00.000Z";
const LONG_AGO = "2026-09-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("issue-sync-project");

type SyncCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.issue-link.sync" }
>;
interface Read {
  readonly host: string;
  readonly repository: string;
  readonly numbers: ReadonlyArray<number>;
}

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(1));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function makeLink(
  number: number,
  snapshot: { readonly state: "open" | "closed"; readonly syncedAt: string } | null = null,
  repository = "acme/web",
  host = "github.com",
): ThreadIssueLink {
  return {
    host,
    repository,
    number,
    url: `https://${host}/${repository}/issues/${number}`,
    source: "manual",
    linkedAt: LONG_AGO,
    snapshot: snapshot === null ? null : { title: `Issue ${number}`, ...snapshot },
  };
}

const insertThread = Effect.fn("insertThread")(function* (
  id: string,
  issues: ReadonlyArray<ThreadIssueLink>,
  options: { readonly archived?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = yield* encodePayload({ issues });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, payload_json
    ) VALUES (
      ${id}, ${PROJECT_ID}, ${id}, 'codex', 'full-access', 'default',
      ${LONG_AGO}, ${LONG_AGO}, ${options.archived === true ? LONG_AGO : null}, ${payload}
    )
  `;
  return { id: ThreadId.make(id), projectId: PROJECT_ID, issues };
});

// GitHub answers every number open, so a stored open snapshot is unchanged and writes nothing.
const openSummary = (number: number): GitHubIssueSummary => ({
  title: `Issue ${number}`,
  state: "open",
  closeReason: null,
});

const makeHarness = Effect.fn("makeThreadIssueSyncHarness")(function* (
  summaries: (
    read: Read,
  ) => Effect.Effect<ReadonlyMap<number, GitHubIssueSummary>, GitHubIssueOperationError> = (read) =>
    Effect.succeed(new Map(read.numbers.map((number) => [number, openSummary(number)]))),
) {
  const activation = yield* Deferred.make<void>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const reads = yield* Ref.make<ReadonlyArray<Read>>([]);
  const syncs = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const started = yield* Queue.unbounded<void>();
  const stateChanges = yield* Queue.unbounded<ThreadIssueKey>();

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    command.type === "thread.issue-link.sync"
      ? Ref.update(syncs, (all) => [...all, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        )
      : Effect.die(new Error(`Unexpected command: ${command.type}`));

  const dependencies = Layer.mergeAll(
    Layer.mock(GitHubIssueService)({
      summaries: (read) =>
        Ref.update(reads, (all) => [...all, read]).pipe(
          Effect.andThen(Queue.offer(started, undefined)),
          Effect.andThen(summaries(read)),
        ),
      subscribeStateChanges: Effect.succeed(Stream.fromQueue(stateChanges)),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch,
      streamDomainEvents: Stream.fromQueue(events),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
  );

  const context = yield* Layer.build(
    ThreadIssueSyncReactor.layer.pipe(Layer.provide(dependencies)),
  );
  const reactor = Context.get(context, ThreadIssueSyncReactor.ThreadIssueSyncReactor);
  const activate = Deferred.succeed(activation, undefined);
  const syncedLinks = Ref.get(syncs).pipe(
    Effect.map((all) => all.map((sync) => `${sync.threadId}#${sync.number}`).toSorted()),
  );
  return { activate, events, stateChanges, reads, syncs, syncedLinks, started, reactor };
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(SqlitePersistence.layerMemory));

describe("ThreadIssueSyncReactor", () => {
  it.effect(
    "sweeps open links on live threads, one read per repository, writing only changes",
    () =>
      run(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          yield* insertThread("one", [
            makeLink(1),
            makeLink(2, { state: "open", syncedAt: LONG_AGO }),
            makeLink(3, { state: "closed", syncedAt: LONG_AGO }),
          ]);
          // A settled thread's issues stay in the sweep; only archived threads leave it.
          yield* insertThread("two", [makeLink(1), makeLink(7, null, "acme/api")]);
          // The same number on another host is another issue, read from that host.
          yield* insertThread("enterprise", [makeLink(1, null, "acme/web", "ghe.acme.test")]);
          // An archived twin of a live link takes no unrequested write.
          yield* insertThread("archived", [makeLink(1), makeLink(4)], { archived: true });
          const fixture = yield* makeHarness((read) =>
            Effect.succeed(
              new Map(
                read.numbers.map((number) => [
                  number,
                  // #7 closed on GitHub since it was linked.
                  number === 7
                    ? {
                        title: "Issue 7",
                        state: "closed" as const,
                        closeReason: "completed" as const,
                      }
                    : openSummary(number),
                ]),
              ),
            ),
          );
          yield* fixture.activate;
          yield* Queue.takeN(fixture.started, 3);
          yield* fixture.reactor.drain;

          assert.sameDeepMembers(
            [...(yield* Ref.get(fixture.reads))],
            [
              { host: "github.com", repository: "acme/web", numbers: [1, 2] },
              { host: "github.com", repository: "acme/api", numbers: [7] },
              { host: "ghe.acme.test", repository: "acme/web", numbers: [1] },
            ],
          );
          // #1 is read once for both threads; #2 is unchanged, so it writes nothing.
          assert.deepStrictEqual(yield* fixture.syncedLinks, [
            "enterprise#1",
            "one#1",
            "two#1",
            "two#7",
          ]);
          assert.strictEqual((yield* Ref.get(fixture.syncs))[0]?.snapshot.syncedAt, NOW);

          // Open links come due again after the sync interval, and not before.
          yield* TestClock.adjust(ThreadIssueSyncReactor.THREAD_ISSUE_SYNC_INTERVAL_MS);
          yield* Queue.takeN(fixture.started, 3);
          yield* fixture.reactor.drain;
          assert.lengthOf(yield* Ref.get(fixture.reads), 6);
        }),
      ),
  );

  it.effect("a panel opening rereads only stale links; a refresh rereads every link", () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        // Archived, so the sweep leaves it alone and only requests read it.
        const thread = yield* insertThread(
          "one",
          [
            makeLink(1),
            makeLink(2, { state: "open", syncedAt: "2026-09-30T11:59:00.000Z" }),
            makeLink(3, { state: "closed", syncedAt: "2026-09-30T11:00:00.000Z" }),
            makeLink(4, { state: "open", syncedAt: LONG_AGO }),
          ],
          { archived: true },
        );
        // A live twin's sweep read writes nothing here, so #4 stays stale for this thread.
        yield* insertThread("live", [makeLink(4, { state: "open", syncedAt: LONG_AGO })]);
        const fixture = yield* makeHarness();
        yield* fixture.activate;
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;

        yield* fixture.reactor.syncThread(thread, "stale");
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.reads)).map((read) => read.numbers),
          [[4], [1, 3, 4]],
        );

        yield* fixture.reactor.syncThread(thread, "all");
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.reads)).map((read) => read.numbers),
          [[4], [1, 3, 4], [1, 2, 3, 4]],
        );
      }),
    ),
  );

  it.effect("reads a live link and an in-app state change at once", () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const child = {
          number: 6,
          title: "Child",
          url: "https://github.com/acme/api/issues/6",
          state: "open" as const,
          closeReason: null,
        };
        yield* insertThread(
          "parent",
          [{ ...makeLink(8), snapshot: { ...openSummary(8), subIssues: [child], syncedAt: NOW } }],
          { archived: true },
        );
        const fixture = yield* makeHarness((read) =>
          Effect.succeed(
            new Map(
              read.numbers.map((number) => [
                number,
                number === 8
                  ? {
                      ...openSummary(8),
                      subIssues: [{ ...child, state: "closed" as const, closeReason: "completed" }],
                    }
                  : openSummary(number),
              ]),
            ),
          ),
        );
        yield* fixture.activate;
        const link = { ...makeLink(5), linkedAt: NOW };
        yield* insertThread("linked", [link], { archived: true });
        // A link lands as `thread.metadata-updated` carrying the whole thread; the reactor reads
        // only its links, so the rest of the payload is left out.
        yield* Queue.offer(fixture.events, {
          type: "thread.metadata-updated",
          id: EventId.make("metadata-updated"),
          threadId: ThreadId.make("linked"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          occurredAt: DateTime.makeUnsafe(NOW),
          payload: { id: ThreadId.make("linked"), projectId: PROJECT_ID, issues: [link] },
        } as unknown as OrchestrationV2DomainEvent);
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;

        assert.deepStrictEqual(yield* fixture.syncedLinks, ["linked#5"]);

        // An archived thread still takes a requested read; the key matches case-insensitively.
        yield* Queue.offer(fixture.stateChanges, {
          host: "GitHub.com",
          repository: "ACME/Web",
          number: 5,
        });
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;
        assert.lengthOf(yield* Ref.get(fixture.reads), 2);

        // A sub-issue's change rereads the linked parent that lists it, keyed by the repository in
        // the child's URL, and the parent's changed child writes a new snapshot.
        yield* Queue.offer(fixture.stateChanges, {
          host: "github.com",
          repository: "acme/api",
          number: 6,
        });
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;
        assert.deepStrictEqual((yield* Ref.get(fixture.reads)).at(-1)?.numbers, [8]);
        const parentSync = (yield* Ref.get(fixture.syncs)).at(-1);
        assert.strictEqual(parentSync?.number, 8);
        assert.strictEqual(parentSync?.snapshot.subIssues?.[0]?.state, "closed");
      }),
    ),
  );

  it.effect("a failed read writes nothing and waits for the next interval", () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        yield* insertThread("one", [makeLink(1)]);
        const fixture = yield* makeHarness(() =>
          Effect.fail(new GitHubIssueOperationError({ operation: "summaries", detail: "offline" })),
        );
        yield* fixture.activate;
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;
        assert.lengthOf(yield* Ref.get(fixture.syncs), 0);

        yield* TestClock.adjust(ThreadIssueSyncReactor.THREAD_ISSUE_SYNC_INTERVAL_MS);
        yield* Queue.take(fixture.started);
        yield* fixture.reactor.drain;
        assert.lengthOf(yield* Ref.get(fixture.reads), 2);
      }),
    ),
  );
});
