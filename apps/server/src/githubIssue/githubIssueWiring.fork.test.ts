// Fork-owned: the issue RPCs that feed the sync reactor (RSI-Software/t3code-hyprws#1434).
// `syncThreadLinks` reads the thread shell and hands its links over, an unknown or deleted
// thread answering not found; `setState` asks for a reread of the issue it changed.
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
import type * as SqlClient from "effect/sql/SqlClient";

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
  { setState: () => Effect.void } as Partial<
    GitHubIssueService.GitHubIssueService["Service"]
  > as GitHubIssueService.GitHubIssueService["Service"],
  {} as SqlClient.SqlClient,
);

it.effect("syncs a known thread's links and answers not found for any other thread", () =>
  Effect.gen(function* () {
    const requested = yield* Ref.make<ReadonlyArray<readonly [ThreadId, ThreadIssueSyncScope]>>([]);
    const requestedIssues = yield* Ref.make<ReadonlyArray<number>>([]);
    const dependencies = Layer.mergeAll(
      // The shell read already leaves out a deleted thread.
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadShell: (threadId) => Effect.succeed(threadId === known ? shell : null),
      }),
      Layer.succeed(ThreadIssueSyncReactor.ThreadIssueSyncReactor, {
        drain: Effect.void,
        syncThread: (thread, scope) =>
          Ref.update(requested, (all) => [...all, [thread.id, scope] as const]),
        requestSync: (key) => Ref.update(requestedIssues, (all) => [...all, key.number]),
      }),
    );
    // A close in the app rereads the issue for every thread that links it.
    yield* handlers["githubIssues.setState"]({
      projectId: ProjectId.make("project-1"),
      repository: "acme/web",
      number: 12,
      state: "closed",
    }).pipe(Effect.provide(dependencies));
    assert.deepStrictEqual(yield* Ref.get(requestedIssues), [12]);

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
