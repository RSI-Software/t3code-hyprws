// Fork-owned GitHub reads for thread ↔ issue links, shaped like `PullRequestSyncReactor`: a sweep
// each minute rereads the open links on live threads, and a new link, a panel opening, a refresh,
// or an in-app close asks for a read at once. Reads fold back through `thread.issue-link.sync`,
// so replay rebuilds the same projection.
import {
  CommandId,
  githubIssueLinkTarget,
  ThreadIssueLink,
  type GitHubSubIssue,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadIssueKey,
  ThreadIssueSnapshot,
  type ThreadIssueSyncScope,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { normalizeThreadIssueKey } from "../orchestration-v2/ThreadIssues.fork.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitHubIssueService from "./GitHubIssueService.ts";

/** An open or unread link is reread this often; a closed one only when asked. */
export const THREAD_ISSUE_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
/** Repository batches in flight at once, across every project. */
const THREAD_ISSUE_READ_CONCURRENCY = 4;

interface LinkEntry {
  readonly threadId: ThreadId;
  readonly archived: boolean;
  readonly link: ThreadIssueLink;
}

interface IssueRead {
  readonly key: ThreadIssueKey;
  readonly recipients: ReadonlyArray<LinkEntry>;
}

const decodeLink = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadIssueLink));

// Reads use the host's credentials, never a project's, so one read serves every project.
const issueKey = (key: ThreadIssueKey) => {
  const normalized = normalizeThreadIssueKey(key);
  return `${normalized.host}/${normalized.repository}#${normalized.number}`;
};

// A child names its repository only in its URL, which may differ from its parent's.
const subIssueKey = (child: GitHubSubIssue): string | null => {
  const target = githubIssueLinkTarget(child.url);
  return target === null ? null : issueKey(target);
};

const sameSnapshotFields = Schema.toEquivalence(ThreadIssueSnapshot);

// An older snapshot may omit `closeReason` where a read sends null; both mean no reason.
const sameSnapshot = (
  stored: ThreadIssueSnapshot,
  read: Omit<ThreadIssueSnapshot, "syncedAt">,
): boolean =>
  sameSnapshotFields(
    { ...stored, closeReason: stored.closeReason ?? null },
    { ...read, closeReason: read.closeReason ?? null, syncedAt: stored.syncedAt },
  );

export class ThreadIssueSyncReactor extends Context.Service<
  ThreadIssueSyncReactor,
  {
    readonly drain: Effect.Effect<void>;
    /** Queue reads for a thread's links: the stale ones, or every one. */
    readonly syncThread: (
      thread: Pick<OrchestrationV2ThreadShell, "id" | "issues">,
      scope: ThreadIssueSyncScope,
    ) => Effect.Effect<void>;
    /** Queue a read of one issue for every thread that links it. */
    readonly requestSync: (key: ThreadIssueKey) => Effect.Effect<void>;
  }
>()("t3/githubIssue/ThreadIssueSyncReactor.fork/ThreadIssueSyncReactor") {}

/** @public */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const githubIssues = yield* GitHubIssueService.GitHubIssueService;
  const crypto = yield* SecureRandom.SecureRandom;
  const sql = yield* SqlClient.SqlClient;

  // When each group was last asked for, answered or not, so a failing read waits its turn.
  const lastReadAt = new Map<string, number>();
  // The same per thread, for a panel opening: an archived twin the sweep skipped is not fresh.
  const threadReadAt = new Map<string, number>();
  const threadKey = (threadId: ThreadId, key: ThreadIssueKey) => `${threadId}\0${issueKey(key)}`;
  const requested = new Set<string>();
  let requestedSweepQueued = false;

  const lastRead = (key: string, links: ReadonlyArray<ThreadIssueLink>): number =>
    lastReadAt.get(key) ??
    Math.min(
      ...links.map((link) =>
        link.snapshot === null ? Number.NEGATIVE_INFINITY : Date.parse(link.snapshot.syncedAt),
      ),
    );

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  // Archived threads are read too, so a panel opened on one still answers its refresh.
  const readLinks = sql<{ threadId: ThreadId; archived: number; link: string }>`
    SELECT t.thread_id AS "threadId", t.archived_at IS NOT NULL AS archived,
      link.value AS link
    FROM orchestration_v2_projection_threads AS t
    JOIN json_each(t.payload_json, '$.issues') AS link
    WHERE t.deleted_at IS NULL
  `.pipe(
    Effect.map((rows) =>
      rows.flatMap((row): Array<LinkEntry> => {
        const link = decodeLink(row.link);
        return Option.isNone(link)
          ? []
          : [{ ...row, archived: row.archived !== 0, link: link.value }];
      }),
    ),
  );

  const readBatch = Effect.fn("ThreadIssueSyncReactor.readBatch")(function* (
    batch: ReadonlyArray<IssueRead>,
  ) {
    const first = normalizeThreadIssueKey(batch[0]!.key);
    const started = yield* DateTime.now;
    const startedMs = DateTime.toEpochMillis(started);
    for (const { key, recipients } of batch) {
      lastReadAt.set(issueKey(key), startedMs);
      for (const { threadId } of recipients) threadReadAt.set(threadKey(threadId, key), startedMs);
    }
    const read = yield* githubIssues
      .summaries({
        host: first.host,
        repository: batch[0]!.key.repository,
        numbers: batch.map(({ key }) => key.number),
      })
      .pipe(Effect.option);
    if (Option.isNone(read)) {
      // A failed read writes nothing: an unread link stays unknown and a known snapshot is kept.
      yield* Effect.logWarning("linked issue read failed", {
        repository: `${first.host}/${first.repository}`,
      });
      return;
    }
    // The read's start time, so a link made while it was in flight rejects it as older.
    const syncedAt = DateTime.formatIso(started);
    yield* Effect.forEach(
      batch.flatMap(({ recipients }) => recipients),
      ({ threadId, link }) => {
        const summary = read.value.get(link.number);
        if (summary === undefined) return Effect.void;
        if (link.snapshot !== null && sameSnapshot(link.snapshot, summary)) return Effect.void;
        return crypto.uuidV4().pipe(
          Effect.flatMap((uuid) =>
            engine.dispatch({
              type: "thread.issue-link.sync",
              commandId: CommandId.make(`server:issue-sync:${threadId}:${uuid}`),
              threadId,
              host: link.host,
              repository: link.repository,
              number: link.number,
              snapshot: { ...summary, syncedAt },
            }),
          ),
          Effect.catchCause(
            logSkipped("linked issue sync skipped", { threadId, number: link.number }),
          ),
        );
      },
      { discard: true },
    );
  });

  const sweep = Effect.fn("ThreadIssueSyncReactor.sweep")(function* (scope: "all" | "requested") {
    const entries = yield* readLinks;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    // Requests are taken now; one arriving during the reads waits for the next sweep.
    const asked = new Set(requested);
    requested.clear();

    const groups = new Map<string, Array<LinkEntry>>();
    for (const entry of entries) {
      const key = issueKey(entry.link);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [entry]);
      else group.push(entry);
    }
    for (const key of lastReadAt.keys()) if (!groups.has(key)) lastReadAt.delete(key);
    const linked = new Set(entries.map((entry) => threadKey(entry.threadId, entry.link)));
    for (const key of threadReadAt.keys()) if (!linked.has(key)) threadReadAt.delete(key);

    // Unlike pull requests, settled threads stay in the sweep: their issues often close later.
    const batches = new Map<string, Array<IssueRead>>();
    for (const [key, group] of groups) {
      const links = group.map((entry) => entry.link);
      // A child read on request rereads its linked parent too, so the parent's progress follows.
      const wanted =
        asked.has(key) ||
        links.some((link) =>
          (link.snapshot?.subIssues ?? []).some((child) => {
            const childKey = subIssueKey(child);
            return childKey !== null && asked.has(childKey);
          }),
        );
      const due =
        wanted ||
        (scope === "all" &&
          group.some(
            (entry) =>
              !entry.archived &&
              (entry.link.snapshot === null || entry.link.snapshot.state === "open"),
          ) &&
          nowMs - lastRead(key, links) >= THREAD_ISSUE_SYNC_INTERVAL_MS);
      if (!due) continue;
      const repository = normalizeThreadIssueKey(links[0]!);
      const batchKey = `${repository.host}/${repository.repository}`;
      // Archived threads take a read only when one was asked for.
      const read = {
        key: links[0]!,
        recipients: wanted ? group : group.filter((entry) => !entry.archived),
      };
      const batch = batches.get(batchKey);
      if (batch === undefined) batches.set(batchKey, [read]);
      else batch.push(read);
    }
    yield* Effect.forEach(batches.values(), readBatch, {
      concurrency: THREAD_ISSUE_READ_CONCURRENCY,
      discard: true,
    });
  });

  const worker = yield* makeDrainableWorker((scope: "all" | "requested") =>
    Effect.suspend(() => {
      if (scope === "requested") requestedSweepQueued = false;
      return sweep(scope);
    }).pipe(Effect.catchCause(logSkipped("linked issue sync sweep failed", {}))),
  );

  const requestSync: ThreadIssueSyncReactor["Service"]["requestSync"] = (key) =>
    Effect.suspend(() => {
      requested.add(issueKey(key));
      if (requestedSweepQueued) return Effect.void;
      requestedSweepQueued = true;
      return worker.enqueue("requested");
    });

  const syncThread: ThreadIssueSyncReactor["Service"]["syncThread"] = Effect.fn(
    "ThreadIssueSyncReactor.syncThread",
  )(function* (thread, scope) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Effect.forEach(
      (thread.issues ?? []).filter(
        (link) =>
          scope === "all" ||
          nowMs -
            (threadReadAt.get(threadKey(thread.id, link)) ??
              (link.snapshot === null
                ? Number.NEGATIVE_INFINITY
                : Date.parse(link.snapshot.syncedAt))) >=
            THREAD_ISSUE_SYNC_INTERVAL_MS,
      ),
      requestSync,
      { discard: true },
    );
  });

  // A link lands as the upstream `thread.metadata-updated` event; the link it just made is the
  // unread one stamped with the event's own time, so any other thread update reads nothing.
  yield* forkParked(
    Stream.runForEach(engine.streamDomainEvents, (event) => {
      if (event.type !== "thread.metadata-updated") return Effect.void;
      const linkedAt = DateTime.formatIso(event.occurredAt);
      return Effect.forEach(
        (event.payload.issues ?? []).filter(
          (link) => link.snapshot === null && link.linkedAt === linkedAt,
        ),
        requestSync,
        { discard: true },
      );
    }).pipe(Effect.catchCause(logSkipped("linked issue event stream failed", {}))),
  );
  yield* forkParked(
    githubIssues.subscribeStateChanges.pipe(
      Effect.flatMap((changes) => Stream.runForEach(changes, requestSync)),
      Effect.catchCause(logSkipped("linked issue state change stream failed", {})),
    ),
  );
  yield* forkParked(
    Effect.gen(function* () {
      yield* worker.enqueue("all");
      yield* worker.drain;
    }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
  );

  return {
    drain: worker.drain,
    syncThread,
    requestSync,
  } satisfies ThreadIssueSyncReactor["Service"];
});

export const layer = Layer.effect(ThreadIssueSyncReactor, make);
