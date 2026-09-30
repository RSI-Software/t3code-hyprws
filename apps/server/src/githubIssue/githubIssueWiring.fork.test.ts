// Fork-owned: the `githubIssues.syncThreadLinks` RPC on Orchestrator V2
// (RSI-Software/t3code-hyprws#1434). It reads the thread shell and hands its
// links to the sync reactor; an unknown or deleted thread answers not found.
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ThreadIssueSyncScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as GitHubIssueService from "./GitHubIssueService.ts";
import { gitHubIssueRpcHandlersFork } from "./githubIssueWiring.fork.ts";
import * as ThreadIssueSyncReactor from "./ThreadIssueSyncReactor.fork.ts";

const known = ThreadId.make("thread-known");
const shell = {
  id: known,
  projectId: ProjectId.make("project-1"),
  issues: [],
} as unknown as OrchestrationV2ThreadShell;

const handlers = gitHubIssueRpcHandlersFork(
  {} as GitHubIssueService.GitHubIssueService["Service"],
  (_method, effect) => effect,
  {} as SqlClient.SqlClient,
);

it.effect("syncs a known thread's links and answers not found for any other thread", () =>
  Effect.gen(function* () {
    const requested = yield* Ref.make<ReadonlyArray<readonly [ThreadId, ThreadIssueSyncScope]>>([]);
    const dependencies = Layer.mergeAll(
      // The shell read already leaves out a deleted thread.
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadShell: (threadId) => Effect.succeed(threadId === known ? shell : null),
      }),
      Layer.succeed(ThreadIssueSyncReactor.ThreadIssueSyncReactor, {
        drain: Effect.void,
        syncThread: (thread, scope) =>
          Ref.update(requested, (all) => [...all, [thread.id, scope] as const]),
      }),
    );
    const sync = (threadId: ThreadId, scope: ThreadIssueSyncScope) =>
      handlers["githubIssues.syncThreadLinks"]({ threadId, scope }).pipe(
        Effect.provide(dependencies),
      );

    yield* sync(known, "stale");
    assert.deepStrictEqual(yield* Ref.get(requested), [[known, "stale"]]);

    const error = yield* sync(ThreadId.make("thread-gone"), "all").pipe(Effect.flip);
    assert.strictEqual(error._tag, "GitHubIssueOperationError");
    assert.include(error.message, "was not found");
    assert.lengthOf(yield* Ref.get(requested), 1);
  }),
);
