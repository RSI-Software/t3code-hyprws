// Fork-only: GitHub issue RPC handler wiring for commit `9f92309411`
// (feat(issues): add GitHub Issues surface scoped to project windows). The
// upstream `ws.ts` carries only marked hook lines pointing here; the handler
// table entries and the service-layer wiring are spread in through
// `github-issues/ws-rpc-handlers`, `github-issues/server-service-live`, and
// friends.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  GitHubIssueListInput,
  GitHubIssueRef,
  GitHubIssueSetStateInput,
  ThreadIssueKey,
  ThreadIssueSyncInput,
} from "@t3tools/contracts";
import { GitHubIssueOperationError } from "@t3tools/contracts";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubIssueService from "./GitHubIssueService.ts";
import * as ThreadIssueSyncReactor from "./ThreadIssueSyncReactor.fork.ts";
import { listLinkedIssueThreadsFork } from "./linkedThreads.fork.ts";

type GitHubIssues = typeof GitHubIssueService.GitHubIssueService.Service;

/**
 * Spread into the upstream WS RPC handler table through the marked hook
 * `github-issues/ws-rpc-handlers` in `ws.ts`. Instrumentation and authorization
 * wrap every handler through the group's middleware (`RpcInstrumentation` and
 * `RpcScopeAuthorization`), so a handler returns its plain effect and carries no
 * observation of its own.
 */
export const gitHubIssueRpcHandlersFork = (
  githubIssues: GitHubIssues,
  sql: SqlClient.SqlClient,
) => ({
  "githubIssues.list": (input: GitHubIssueListInput) => githubIssues.list(input),
  "githubIssues.detail": (input: GitHubIssueRef) => githubIssues.detail(input),
  "githubIssues.linkedThreads": (input: ThreadIssueKey) =>
    listLinkedIssueThreadsFork(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  "githubIssues.setState": (input: GitHubIssueSetStateInput) => githubIssues.setState(input),
  // An active thread only: an unknown or deleted one answers not found.
  "githubIssues.syncThreadLinks": (input: ThreadIssueSyncInput) =>
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadShell(input.threadId),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubIssueOperationError({
            operation: "syncThreadLinks",
            detail: "The thread could not be read.",
            cause,
          }),
      ),
      // The shell read serves active and archived threads, never a deleted one.
      Effect.flatMap((thread) =>
        thread === null
          ? Effect.fail(
              new GitHubIssueOperationError({
                operation: "syncThreadLinks",
                detail: `Thread ${input.threadId} was not found.`,
              }),
            )
          : Effect.flatMap(ThreadIssueSyncReactor.ThreadIssueSyncReactor, (sync) =>
              sync.syncThread(thread, input.scope),
            ),
      ),
    ),
});

/**
 * The upstream-shaped service layer, composed with its own dependencies. The
 * project list and repository identities come from the server runtime; the
 * GitHub reads go through the API service the runtime already provides to the
 * pull-request providers.
 */
export const gitHubIssueServiceLiveFork = GitHubIssueService.layer.pipe(
  Layer.provide(GitHubApi.layer),
);

/**
 * Linked issue reads on link, panel open, and refresh, joined to the runtime
 * core through `github-issues/server-issue-sync-reactor` in `server.ts`. The
 * same layer value as the routes' service, so both share one instance.
 */
export const threadIssueSyncReactorLiveFork = ThreadIssueSyncReactor.layer.pipe(
  Layer.provide(gitHubIssueServiceLiveFork),
);
