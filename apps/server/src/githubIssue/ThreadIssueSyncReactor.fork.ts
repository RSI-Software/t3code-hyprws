// Fork-owned GitHub reads for thread ↔ issue links (RSI-Software/t3code-hyprws#1434), modeled
// on the pull request sync but on demand only: a live link, a thread panel opening, or an
// explicit refresh. There is no periodic sweep. Reads fold back through
// `thread.issue-link.sync`, so replay rebuilds the same projection.
import {
  CommandId,
  type OrchestrationThreadShell,
  type ProjectId,
  type ThreadId,
  type ThreadIssueKey,
  type ThreadIssueLink,
  type ThreadIssueSyncScope,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { normalizeThreadIssueKey } from "../orchestration/threadIssues.fork.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitHubIssueService from "./GitHubIssueService.ts";

/** A snapshot younger than this is fresh enough that opening the panel does not reread it. */
const THREAD_ISSUE_STALE_AFTER_MS = 5 * 60 * 1_000;
/** Host reads in flight at once, across every thread. */
export const THREAD_ISSUE_READ_CONCURRENCY = 4;

interface IssueRead {
  readonly projectId: ProjectId;
  readonly key: ThreadIssueKey;
  readonly threads: Set<ThreadId>;
  /** When the host read began; a link made after it waits for the next read. */
  startedAtMs?: number;
}

const keyString = (key: ThreadIssueKey): string => {
  const normalized = normalizeThreadIssueKey(key);
  return `${normalized.host}/${normalized.repository}#${normalized.number}`;
};

const isStale = (link: ThreadIssueLink, nowMs: number): boolean =>
  link.snapshot === null ||
  nowMs - Date.parse(link.snapshot.syncedAt) >= THREAD_ISSUE_STALE_AFTER_MS;

export class ThreadIssueSyncReactor extends Context.Service<
  ThreadIssueSyncReactor,
  {
    readonly drain: Effect.Effect<void>;
    /** Queue reads for a thread's links: the stale ones, or every one. */
    readonly syncThread: (
      thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "issues">,
      scope: ThreadIssueSyncScope,
    ) => Effect.Effect<void>;
  }
>()("t3/githubIssue/ThreadIssueSyncReactor.fork/ThreadIssueSyncReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const githubIssues = yield* GitHubIssueService.GitHubIssueService;
  const crypto = yield* Crypto.Crypto;

  // One read per issue: requests for the same issue share a queued or in-flight read.
  const pending = new Map<string, IssueRead>();
  const inFlight = new Map<string, IssueRead>();

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  const readIssue = Effect.fn("ThreadIssueSyncReactor.readIssue")(function* (
    id: string,
    read: IssueRead,
  ) {
    const started = yield* DateTime.now;
    read.startedAtMs = DateTime.toEpochMillis(started);
    inFlight.set(id, read);
    const detail = yield* githubIssues
      .detail({
        projectId: read.projectId,
        repository: read.key.repository,
        number: read.key.number,
      })
      .pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(id))), Effect.option);
    if (Option.isNone(detail)) {
      // A failed read writes nothing: an unread link stays unknown and a known snapshot is kept,
      // because either is truer than a guessed state.
      yield* Effect.logWarning("linked issue read failed", { issue: id });
      return;
    }
    // The read's start time, so a link made while it was in flight rejects it as older.
    const snapshot = {
      title: detail.value.title,
      state: detail.value.state,
      syncedAt: DateTime.formatIso(started),
    };
    yield* Effect.forEach(
      read.threads,
      (threadId) =>
        crypto.randomUUIDv4.pipe(
          Effect.flatMap((uuid) =>
            engine.dispatch({
              type: "thread.issue-link.sync",
              commandId: CommandId.make(`server:issue-sync:${threadId}:${uuid}`),
              threadId,
              ...read.key,
              snapshot,
            }),
          ),
          Effect.catchCause(logSkipped("linked issue sync skipped", { threadId, issue: id })),
        ),
      { discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((_: void) =>
    Effect.suspend(() => {
      const batch = [...pending];
      pending.clear();
      return Effect.forEach(batch, ([id, read]) => readIssue(id, read), {
        concurrency: THREAD_ISSUE_READ_CONCURRENCY,
        discard: true,
      });
    }).pipe(Effect.catchCause(logSkipped("linked issue reads failed", {}))),
  );

  const request = (projectId: ProjectId, threadId: ThreadId, link: ThreadIssueLink) => {
    const id = keyString(link);
    const running = inFlight.get(id);
    if (running?.startedAtMs !== undefined && Date.parse(link.linkedAt) <= running.startedAtMs) {
      running.threads.add(threadId);
      return;
    }
    const queued = pending.get(id);
    if (queued !== undefined) {
      queued.threads.add(threadId);
      return;
    }
    const key = normalizeThreadIssueKey(link);
    pending.set(id, {
      projectId,
      key: { ...key, repository: link.repository },
      threads: new Set([threadId]),
    });
  };

  const syncThread: ThreadIssueSyncReactor["Service"]["syncThread"] = (thread, scope) =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const links = (thread.issues ?? []).filter((link) => scope === "all" || isStale(link, nowMs));
      if (links.length === 0) return;
      for (const link of links) request(thread.projectId, thread.id, link);
      yield* worker.enqueue(undefined);
    });

  // Starts with its layer, parked until the server activates. Live events only: a server start
  // replays nothing here, so boot rereads no historical link.
  const events = yield* engine.subscribeDomainEvents;
  yield* forkParked(
    Stream.runForEach(events, (event) =>
      event.type !== "thread.issue-linked"
        ? Effect.void
        : snapshots.getThreadShellById(event.payload.threadId).pipe(
            Effect.flatMap((thread) =>
              Option.match(thread, {
                onNone: () => Effect.void,
                onSome: (shell) =>
                  Effect.sync(() => request(shell.projectId, shell.id, event.payload.link)).pipe(
                    Effect.andThen(worker.enqueue(undefined)),
                  ),
              }),
            ),
            Effect.catchCause(logSkipped("linked issue read not queued", {})),
          ),
    ),
  );

  return { drain: worker.drain, syncThread } satisfies ThreadIssueSyncReactor["Service"];
});

export const layer = Layer.effect(ThreadIssueSyncReactor, make);

/** Reads nothing: for harnesses that serve the RPC without GitHub. */
export const layerInert = Layer.succeed(ThreadIssueSyncReactor, {
  drain: Effect.void,
  syncThread: () => Effect.void,
});
