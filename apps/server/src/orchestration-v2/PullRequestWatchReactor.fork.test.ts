import {
  ProjectId,
  PullRequestOperationError,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type PullRequestDetail,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";

const AT = "2026-10-02T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("watch-project");

type WatchSync = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.pull-request-watch.sync" }
>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const link: ThreadPullRequestLink = {
  host: "github.com",
  repository: "owner/repository",
  number: 9,
  url: "https://github.com/owner/repository/pull/9",
  source: "agent",
  linkedAt: AT,
  snapshot: null,
  stack: null,
  watch: {
    startedAt: AT,
    headSha: "abc1234def",
    failedChecks: [],
    passed: false,
    remarksThrough: AT,
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  },
};

const detail: PullRequestDetail = {
  provider: "github",
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: PROJECT_ID,
  projectTitle: "Watch",
  workspaceRoot: "/workspace/watch",
  repository: link.repository,
  number: link.number,
  title: "Watched pull request",
  body: "",
  url: link.url,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: AT,
  updatedAt: AT,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
};

const rateLimited = new PullRequestOperationError({
  operation: "detail",
  detail: "GitHub rate limit reached.",
  cause: new PullRequestProviderError({
    provider: "github",
    operation: "detail",
    reason: "rate-limited",
    detail: "GitHub rate limit reached.",
  }),
});

// A parent thread and its subagent child watching the same pull request.
const makeHarness = (
  readDetail: (
    calls: number,
  ) => Effect.Effect<PullRequestDetail, PullRequestService.PullRequestError>,
) =>
  Effect.gen(function* () {
    const detailCalls = yield* Ref.make(0);
    const activityCalls = yield* Ref.make(0);
    const syncs = yield* Ref.make<ReadonlyArray<WatchSync>>([]);
    const reactor = yield* PullRequestWatchReactor.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(PullRequestService.PullRequestService)({
            detail: () =>
              Ref.updateAndGet(detailCalls, (n) => n + 1).pipe(Effect.flatMap(readDetail)),
            activity: () =>
              Ref.update(activityCalls, (n) => n + 1).pipe(
                Effect.as({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                }),
              ),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadsWithPullRequests: () =>
              Effect.succeed(
                ["parent", "child"].map((id) => ({
                  id: ThreadId.make(id),
                  projectId: PROJECT_ID,
                  settledOverride: null,
                  settledAt: null,
                  pullRequests: [link],
                })),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              command.type === "thread.pull-request-watch.sync"
                ? Ref.update(syncs, (recorded) => [...recorded, command]).pipe(
                    Effect.as({ sequence: 1, storedEvents: [] }),
                  )
                : Effect.die(new Error(`Unexpected command: ${command.type}`)),
          }),
          Layer.succeed(Crypto.Crypto, testCrypto),
        ),
      ),
    );
    const stops = Ref.get(syncs).pipe(
      Effect.map((recorded) => recorded.filter((sync) => sync.watch === null).length),
    );
    return { reactor, detailCalls, activityCalls, stops };
  });

it.effect("reads a watched pull request once a pass, and its conversation when it changes", () =>
  Effect.gen(function* () {
    const updatedAt = yield* Ref.make(AT);
    const { reactor, detailCalls, activityCalls } = yield* makeHarness(() =>
      Ref.get(updatedAt).pipe(Effect.map((at) => ({ ...detail, updatedAt: at }))),
    );
    const reads = Effect.all([Ref.get(detailCalls), Ref.get(activityCalls)]);

    yield* reactor.sweep;
    yield* reactor.sweep;
    assert.deepEqual(yield* reads, [2, 1]);

    yield* Ref.set(updatedAt, "2026-10-02T12:05:00.000Z");
    yield* reactor.sweep;
    assert.deepEqual(yield* reads, [3, 2]);

    yield* TestClock.adjust("10 minutes");
    yield* reactor.sweep;
    assert.deepEqual(yield* reads, [4, 3]);
  }),
);

it.effect("keeps a watch through a rate limit, and ends it when the host cannot read it", () =>
  Effect.gen(function* () {
    const limited = 20;
    const { reactor, stops } = yield* makeHarness((calls) =>
      Effect.fail(
        calls <= limited
          ? rateLimited
          : new PullRequestOperationError({ operation: "detail", detail: "Not readable." }),
      ),
    );

    for (let pass = 0; pass < limited; pass += 1) yield* reactor.sweep;
    assert.equal(yield* stops, 0);

    for (let pass = 0; pass < 15; pass += 1) yield* reactor.sweep;
    assert.equal(yield* stops, 2);
  }),
);
