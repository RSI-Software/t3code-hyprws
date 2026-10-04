import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import type { PullRequestActivity, PullRequestRef } from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { evaluatePullRequestWatch, pullRequestWatchMessage } from "./pullRequestWatch.ts";

/** Passes in a row that could not read a pull request before its watch ends (one a minute). */
const READ_FAILURE_LIMIT = 15;
/** How long an unchanged pull request's conversation is reused before it is read again. */
const CONVERSATION_REFRESH = Duration.minutes(10);

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

interface WatchTarget {
  readonly thread: ProjectionStore.ProjectionThreadPullRequests;
  readonly link: ThreadPullRequestLink;
  readonly watch: ThreadPullRequestWatch;
}

const failureKey = ({ thread, link, watch }: WatchTarget) =>
  `${thread.id} ${threadPullRequestKeyOf(link)} ${watch.startedAt}`;

// Threads in one project read one pull request through the same host credentials.
const readKey = ({ thread, link }: WatchTarget) =>
  `${thread.projectId} ${threadPullRequestKeyOf(link)}`;

interface Conversation {
  readonly updatedAt: string;
  readonly readAt: number;
  readonly activity: PullRequestActivity;
}

// Matches the degraded read `check` skips remarks on, so it is read again rather than reused.
const isDegraded = (activity: PullRequestActivity) =>
  activity.commentsTruncated &&
  !activity.reviewThreads.some((reviewThread) => reviewThread.nextCommentsCursor !== undefined);

const isPullRequestProviderError = Schema.is(PullRequestProviderError);

const isRateLimited = (cause: Cause.Cause<PullRequestService.PullRequestError>) =>
  Option.exists(
    Cause.findErrorOption(cause),
    (error) =>
      error._tag === "PullRequestOperationError" &&
      isPullRequestProviderError(error.cause) &&
      error.cause.reason === "rate-limited",
  );

function watchesEqual(left: ThreadPullRequestWatch, right: ThreadPullRequestWatch): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.headSha === right.headSha &&
    left.failedChecks.join("\n") === right.failedChecks.join("\n") &&
    left.passed === right.passed &&
    left.remarksThrough === right.remarksThrough &&
    left.remarkIds.join("\n") === right.remarkIds.join("\n") &&
    left.conflicting === right.conflicting &&
    left.wakes === right.wakes
  );
}

/**
 * Wakes a thread's agent when a pull request it watches (`watch_pull_request`) needs a look:
 * checks finished on the head commit, someone else commented, or the branch started to
 * conflict. One pass a minute reads each watched pull request; settled threads wait until
 * they are active again, and a merged or closed pull request ends its watch.
 */
export class PullRequestWatchReactor extends Context.Service<
  PullRequestWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every watched pull request. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestWatchReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  // The last conversation read per watched pull request, so an unchanged one is not read again.
  const conversations = new Map<string, Conversation>();

  // Passes in a row that failed, per watch. Kept in memory: a restart only delays the stop.
  const readFailures = new Map<string, number>();

  // Host-level identity, with the repository as linked, the way pull request sync reads it.
  const identityOf = (link: ThreadPullRequestLink) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
  });

  /**
   * One host read of a watched pull request. The conversation costs far more than the rest
   * (GitHub's review thread query), and every comment and review moves the pull request's
   * `updatedAt`, so an unchanged pull request reuses its last conversation for a while.
   */
  const readPullRequest = Effect.fn("PullRequestWatchReactor.read")(function* (
    key: string,
    reference: PullRequestRef,
  ) {
    const detail = yield* pullRequests.detail({ ...reference, allowStale: false });
    const now = yield* Clock.currentTimeMillis;
    const refresh = Duration.toMillis(CONVERSATION_REFRESH);
    for (const [known, conversation] of conversations) {
      if (now - conversation.readAt >= refresh) conversations.delete(known);
    }
    const known = conversations.get(key);
    if (known?.updatedAt === detail.updatedAt) return [detail, known.activity] as const;
    const activity = yield* pullRequests.activity(reference);
    if (isDegraded(activity)) conversations.delete(key);
    else conversations.set(key, { updatedAt: detail.updatedAt, readAt: now, activity });
    return [detail, activity] as const;
  });
  // Every thread watching one pull request shares its host read for the pass.
  const passReads = new Map<string, ReturnType<typeof readPullRequest>>();
  const sharedRead = Effect.fnUntraced(function* (key: string, reference: PullRequestRef) {
    const read = yield* Effect.cached(readPullRequest(key, reference));
    const shared = passReads.get(key) ?? read;
    passReads.set(key, shared);
    return yield* shared;
  });

  /**
   * Records what a pass saw, and wakes the agent with it. The orchestrator applies this only
   * while the same watch is on, so a stop or restart that lands during the host read wins.
   */
  const record = (
    target: WatchTarget,
    next: ThreadPullRequestWatch | null,
    wake?: { readonly text: string; readonly notification: OrchestrationV2Notification },
  ) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`server:pr-watch:${target.thread.id}:${uuid}`),
        threadId: target.thread.id,
        ...identityOf(target.link),
        startedAt: target.watch.startedAt,
        watch: next,
        ...(wake === undefined
          ? {}
          : { wake: { ...wake, messageId: MessageId.make(`message:pr-watch:${uuid}`) } }),
      });
    });

  // A watch that cannot read its pull request ends with a wake saying so, rather than showing
  // "Watching" while it learns nothing.
  const giveUp = (target: WatchTarget) =>
    record(target, null, {
      text: `T3 Code stopped watching pull request #${target.link.number} (${target.link.url}) because it could not read it from the host for ${READ_FAILURE_LIMIT} minutes. Check it yourself, and call watch_pull_request to watch it again.`,
      notification: {
        source: { kind: "monitor" },
        outcome: "failed",
        summary: `#${target.link.number}: stopped watching, could not read it`,
      },
    }).pipe(Effect.catch(() => record(target, null)));

  const check = Effect.fn("PullRequestWatchReactor.check")(function* (target: WatchTarget) {
    const { thread, link, watch } = target;
    const pullRequest = identityOf(link);
    // A merged pull request cannot reopen, so its watch ends without a host read, even on a
    // settled thread. A closed one can, so the host decides below.
    if (link.snapshot?.state === "merged") return yield* record(target, null);
    if (thread.settledOverride === "settled" || thread.settledAt !== null) return;

    const reference = { projectId: thread.projectId, ...pullRequest };
    const read = yield* Effect.exit(sharedRead(readKey(target), reference));
    // Only host reads count towards giving up; a refused wake is not the host's fault.
    const key = failureKey(target);
    if (Exit.isFailure(read)) {
      if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.failCause(read.cause);
      // T3 Code holding its own reads back is not the pull request being unreadable.
      if (isRateLimited(read.cause)) {
        return yield* Effect.logInfo("pull request watch read waits for the host rate limit", {
          threadId: thread.id,
          pullRequest: threadPullRequestKeyOf(link),
        });
      }
      const failures = (readFailures.get(key) ?? 0) + 1;
      readFailures.set(key, failures);
      // The count stays until the stop lands, so a failed stop is tried again next pass.
      if (failures >= READ_FAILURE_LIMIT) {
        yield* giveUp(target);
        readFailures.delete(key);
      }
      return yield* Effect.failCause(read.cause);
    }
    readFailures.delete(key);
    const [detail, activity] = read.value;
    if (detail.state !== "open") return yield* record(target, null);

    // A degraded read (GitHub's review thread query failed) is truncated with no long thread to
    // explain it, and would skip review comments, so remarks wait for a later pass. Replies past
    // the first ten of a long review thread are not read.
    const degraded =
      activity.commentsTruncated &&
      !activity.reviewThreads.some((reviewThread) => reviewThread.nextCommentsCursor !== undefined);
    const report = evaluatePullRequestWatch(watch, detail, degraded ? null : activity.comments);
    if (report.changes.length > 0) {
      return yield* record(
        target,
        report.exhausted ? null : report.next,
        pullRequestWatchMessage({
          number: link.number,
          url: link.url,
          baseBranch: detail.baseBranch,
          headSha: report.next.headSha,
          report,
        }),
      );
    }
    if (!watchesEqual(report.next, watch)) yield* record(target, report.next);
  });

  const sweep = Effect.gen(function* () {
    passReads.clear();
    const threads = yield* projections.getThreadsWithPullRequests();
    const targets = threads.flatMap((thread) =>
      visibleThreadPullRequests(thread.pullRequests ?? []).flatMap((link) =>
        link.watch === undefined ? [] : [{ thread, link, watch: link.watch }],
      ),
    );
    const keys = new Set(targets.map(failureKey));
    for (const key of readFailures.keys()) if (!keys.has(key)) readFailures.delete(key);
    yield* Effect.forEach(
      targets,
      (target) =>
        check(target).pipe(
          Effect.catchCause(
            logFailure("pull request watch check failed", {
              threadId: target.thread.id,
              pullRequest: threadPullRequestKeyOf(target.link),
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCause(logFailure("pull request watch sweep failed", {})),
    Effect.withSpan("PullRequestWatchReactor.sweep"),
  );

  const start: PullRequestWatchReactor["Service"]["start"] = () =>
    forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));

  return { start, sweep } satisfies PullRequestWatchReactor["Service"];
});

export const layer = Layer.effect(PullRequestWatchReactor, make);
