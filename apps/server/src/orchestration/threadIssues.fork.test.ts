import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { listLinkedIssueThreadsFork } from "../githubIssue/linkedThreads.fork.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "./Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const serverConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-issues-fork-" });

/** Snapshot query and projection pipeline over whatever SQL the caller provides. */
const projectionLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(OrchestrationEventStoreLive),
);

const engineLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(projectionLayer),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
);

const withSql = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfig),
    Layer.provideMerge(NodeServices.layer),
  );

const start = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
const t0 = DateTime.toEpochMillis(start);
const at = (seconds: number) => DateTime.formatIso(DateTime.add(start, { seconds }));

const projectId = ProjectId.make("project-issues");
const threadA = ThreadId.make("thread-issues-a");
const threadB = ThreadId.make("thread-issues-b");
const issue: ThreadIssueKey = { host: "github.com", repository: "acme/web", number: 7 };
const issueUrl = "https://github.com/acme/web/issues/7";

let commandCounter = 0;
const commandId = () => CommandId.make(`cmd-issues-${(commandCounter += 1)}`);

const createThread = (threadId: ThreadId): OrchestrationCommand => ({
  type: "thread.create",
  commandId: commandId(),
  threadId,
  projectId,
  title: threadId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: at(0),
});

const link = (
  threadId: ThreadId,
  key: ThreadIssueKey = issue,
  source: "manual" | "handoff" | "agent" = "manual",
): OrchestrationCommand => ({
  type: "thread.issue.link",
  commandId: commandId(),
  threadId,
  ...key,
  url: issueUrl,
  source,
});

const unlink = (threadId: ThreadId, key: ThreadIssueKey = issue): OrchestrationCommand => ({
  type: "thread.issue.unlink",
  commandId: commandId(),
  threadId,
  ...key,
});

const sync = (
  threadId: ThreadId,
  syncedAt: string,
  key: ThreadIssueKey = issue,
): OrchestrationCommand => ({
  type: "thread.issue-link.sync",
  commandId: commandId(),
  threadId,
  ...key,
  snapshot: { title: "Fix the thing", state: "open", syncedAt },
});

const issuesById = (model: OrchestrationReadModel) =>
  Object.fromEntries(
    model.threads
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => [thread.id, thread.issues ?? []]),
  );

const replayEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
  Effect.reduce(
    events,
    () => createEmptyReadModel(at(0)),
    (model, event) => projectEvent(model, event),
  );

it.layer(Layer.fresh(withSql(engineLayer)))("thread issue links", (it) => {
  it.effect("link, sync, unlink, re-link and delete agree across every projection", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);
      const rejected = (command: OrchestrationCommand) =>
        dispatch(command).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );
      const detailIssues = (threadId: ThreadId) =>
        snapshots
          .getThreadDetailById(threadId)
          .pipe(Effect.map((thread) => Option.getOrThrow(thread).issues));

      yield* dispatch({
        type: "project.create",
        commandId: commandId(),
        projectId,
        title: "Issues",
        workspaceRoot: "/tmp/project-issues",
        createdAt: at(0),
      });
      yield* dispatch(createThread(threadA));
      yield* dispatch(createThread(threadB));

      // Linking stores the normalized key, with no state until the first sync.
      yield* TestClock.adjust("10 seconds");
      yield* dispatch(link(threadA, { host: "GitHub.com", repository: "Acme/Web", number: 7 }));
      yield* dispatch(link(threadB, issue, "handoff"));
      assert.deepStrictEqual(yield* detailIssues(threadA), [
        { ...issue, url: issueUrl, source: "manual", linkedAt: at(10), snapshot: null },
      ]);

      // Linking twice changes nothing, however the key is cased.
      const headBefore = yield* engine.latestSequence;
      assert.strictEqual(
        yield* rejected(link(threadA, { ...issue, repository: "ACME/WEB" })),
        "OrchestrationCommandInvariantError",
      );
      assert.strictEqual(yield* engine.latestSequence, headBefore);

      // A snapshot read before the link was made describes an earlier link.
      assert.strictEqual(
        yield* rejected(sync(threadA, at(5))),
        "OrchestrationCommandInvariantError",
      );
      yield* TestClock.adjust("10 seconds");
      yield* dispatch(sync(threadA, at(20)));
      assert.deepStrictEqual((yield* detailIssues(threadA))?.[0]?.snapshot, {
        title: "Fix the thing",
        state: "open",
        syncedAt: at(20),
      });

      // Unlink is a real removal; a second unlink and a sync for it are refused.
      // The last unlink leaves the thread shaped as it was before any link.
      yield* dispatch(unlink(threadA));
      const unlinked = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadA));
      assert.isFalse("issues" in unlinked);
      assert.strictEqual(yield* rejected(unlink(threadA)), "OrchestrationCommandInvariantError");
      assert.strictEqual(
        yield* rejected(sync(threadA, at(20))),
        "OrchestrationCommandInvariantError",
      );

      // Re-linking after an unlink starts a fresh link.
      yield* TestClock.adjust("10 seconds");
      yield* dispatch(link(threadA, issue, "agent"));
      assert.deepStrictEqual(yield* detailIssues(threadA), [
        { ...issue, url: issueUrl, source: "agent", linkedAt: at(30), snapshot: null },
      ]);

      // A deleted thread drops its links and takes no new ones.
      yield* dispatch({ type: "thread.delete", commandId: commandId(), threadId: threadB });
      const orphaned = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_issues WHERE thread_id = ${threadB}
      `;
      assert.strictEqual(orphaned[0]?.count, 0);
      assert.strictEqual(yield* rejected(link(threadB)), "OrchestrationCommandInvariantError");

      // The event log replays to exactly what every SQL reader serves.
      const events = yield* Stream.runCollect(eventStore.readFromSequence(0));
      const replayed = yield* replayEvents(events);
      const expected = { [threadA]: replayed.threads.find((t) => t.id === threadA)?.issues };
      assert.deepStrictEqual(issuesById(replayed), expected);
      assert.isUndefined(replayed.threads.find((thread) => thread.id === threadB)?.issues);
      assert.deepStrictEqual(issuesById(yield* snapshots.getSnapshot()), expected);
      assert.deepStrictEqual(issuesById(yield* snapshots.getCommandReadModel()), expected);
      assert.deepStrictEqual(yield* detailIssues(threadA), expected[threadA]);
      const shell = yield* snapshots.getShellSnapshot();
      assert.deepStrictEqual(
        shell.threads.find((thread) => thread.id === threadA)?.issues,
        expected[threadA],
      );
      assert.deepStrictEqual(
        Option.getOrThrow(yield* snapshots.getThreadShellById(threadA)).issues,
        expected[threadA],
      );

      // So does a projection rebuilt from nothing but that log.
      const rebuilt = yield* Effect.gen(function* () {
        const pipeline = yield* OrchestrationProjectionPipeline;
        const fresh = yield* ProjectionSnapshotQuery;
        yield* Effect.forEach(events, pipeline.projectEvent, { discard: true });
        return issuesById(yield* fresh.getCommandReadModel());
      }).pipe(Effect.provide(Layer.fresh(withSql(projectionLayer))));
      assert.deepStrictEqual(rebuilt, expected);
    }),
  );

  it.effect(
    "both projectors drop a sync for a removed link, an earlier link, or an older read",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(t0 + 60_000);
        const engine = yield* OrchestrationEngineService;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const snapshots = yield* ProjectionSnapshotQuery;
        const threadC = ThreadId.make("thread-issues-c");
        const other: ThreadIssueKey = { ...issue, number: 8 };
        yield* engine.dispatch(createThread(threadC));
        yield* engine.dispatch(link(threadC));

        const model = yield* snapshots.getCommandReadModel();
        const linkedAt = model.threads.find((thread) => thread.id === threadC)?.issues?.[0]
          ?.linkedAt;
        assert.strictEqual(linkedAt, at(60));
        const head = yield* engine.latestSequence;
        const syncedEvent = (sequence: number, key: ThreadIssueKey, syncedAt: string) =>
          ({
            sequence,
            eventId: EventId.make(`evt-issues-stale-${sequence}`),
            aggregateKind: "thread",
            aggregateId: threadC,
            occurredAt: at(90),
            commandId: CommandId.make(`cmd-issues-stale-${sequence}`),
            causationEventId: null,
            correlationId: CommandId.make(`cmd-issues-stale-${sequence}`),
            metadata: {},
            type: "thread.issue-synced",
            payload: {
              threadId: threadC,
              ...key,
              snapshot: { title: "Stale", state: "closed", syncedAt },
              updatedAt: at(90),
            },
          }) satisfies OrchestrationEvent;
        const stale = [syncedEvent(head + 1, issue, at(30)), syncedEvent(head + 2, other, at(90))];

        const inMemory = yield* Effect.reduce(
          stale,
          () => model,
          (current, event) => projectEvent(current, event),
        );
        const memoryThread = inMemory.threads.find((thread) => thread.id === threadC);
        assert.strictEqual(memoryThread?.issues?.[0]?.snapshot, null);
        assert.strictEqual(memoryThread?.issues?.length, 1);

        yield* Effect.forEach(stale, pipeline.projectEvent, { discard: true });
        const stored = yield* snapshots.getThreadDetailById(threadC);
        assert.deepStrictEqual(Option.getOrThrow(stored).issues, memoryThread?.issues);

        // A read that finishes after a newer one never overwrites it.
        yield* engine.dispatch(sync(threadC, at(90)));
        const refused = yield* engine.dispatch(sync(threadC, at(80))).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "OrchestrationCommandInvariantError");
        const synced = yield* snapshots.getCommandReadModel();
        const older = syncedEvent((yield* engine.latestSequence) + 1, issue, at(80));
        const memoryAfter = (yield* projectEvent(synced, older)).threads.find(
          (thread) => thread.id === threadC,
        );
        assert.strictEqual(memoryAfter?.issues?.[0]?.snapshot?.syncedAt, at(90));
        yield* pipeline.projectEvent(older);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(threadC)).issues,
          memoryAfter?.issues,
        );
      }),
  );

  it.effect("a thread re-created under its id starts without the old links on every read", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0 + 120_000);
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const eventStore = yield* OrchestrationEventStore;
      const threadD = ThreadId.make("thread-issues-d");
      const isLinked = listLinkedIssueThreadsFork(issue).pipe(
        Effect.map((result) => result.threads.some((thread) => thread.id === threadD)),
      );
      // Detail (absent once archived), shell list (active or archived), reverse lookup.
      const reads = Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const active = yield* query.getShellSnapshot();
        const archived = yield* query.getArchivedShellSnapshot();
        const listed = [...active.threads, ...archived.threads].find((t) => t.id === threadD);
        return {
          detail: Option.map(yield* query.getThreadDetailById(threadD), (thread) => thread.issues),
          listed: listed?.issues,
          linked: yield* isLinked,
        };
      });
      const rebuild = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.gen(function* () {
          const pipeline = yield* OrchestrationProjectionPipeline;
          yield* Effect.forEach(events, pipeline.projectEvent, { discard: true });
          const replayed = yield* replayEvents(events);
          return {
            ...(yield* reads),
            replayed: replayed.threads.find((thread) => thread.id === threadD)?.issues,
          };
        }).pipe(Effect.provide(Layer.fresh(withSql(projectionLayer))));
      const readLog = Stream.runCollect(eventStore.readFromSequence(0));

      yield* engine.dispatch(createThread(threadD));
      yield* engine.dispatch(link(threadD));
      yield* engine.dispatch(sync(threadD, at(120)));
      assert.isTrue(yield* isLinked);
      yield* engine.dispatch({ type: "thread.delete", commandId: commandId(), threadId: threadD });
      yield* TestClock.adjust("10 seconds");
      yield* engine.dispatch(createThread(threadD));

      const fresh = { detail: Option.some(undefined), listed: undefined, linked: false };
      assert.deepStrictEqual(yield* reads, fresh);
      assert.isFalse("issues" in Option.getOrThrow(yield* snapshots.getThreadShellById(threadD)));
      assert.deepStrictEqual(yield* rebuild(yield* readLog), { ...fresh, replayed: undefined });

      // The new incarnation links on its own, and an archived shell keeps it.
      yield* TestClock.adjust("10 seconds");
      yield* engine.dispatch(link(threadD, issue, "handoff"));
      const relinked = [
        { ...issue, url: issueUrl, source: "handoff" as const, linkedAt: at(140), snapshot: null },
      ];
      assert.deepStrictEqual(
        Option.getOrThrow(yield* snapshots.getThreadShellById(threadD)).issues,
        relinked,
      );
      const current = { detail: Option.some(relinked), listed: relinked, linked: true };
      assert.deepStrictEqual(yield* reads, current);
      assert.deepStrictEqual(yield* rebuild(yield* readLog), { ...current, replayed: relinked });
      yield* engine.dispatch({ type: "thread.archive", commandId: commandId(), threadId: threadD });
      const archived = { ...current, detail: Option.none() };
      assert.deepStrictEqual(yield* reads, archived);
      assert.deepStrictEqual(yield* rebuild(yield* readLog), { ...archived, replayed: relinked });
    }),
  );
});
