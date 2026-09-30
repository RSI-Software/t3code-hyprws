// Fork-only: GitHub issue RPC handler wiring for commit `9f92309411`
// (feat(issues): add GitHub Issues surface scoped to project windows). The
// upstream `ws.ts` carries only marked hook lines pointing here; the handler
// table entries and the service-layer wiring are spread in through
// `github-issues/ws-rpc-handlers`, `github-issues/server-service-live`, and
// friends.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  EnvironmentAuthorizationError,
  GitHubIssueListInput,
  GitHubIssueRef,
  GitHubIssueSetStateInput,
  ThreadIssueKey,
  ThreadIssueSyncInput,
} from "@t3tools/contracts";
import { GitHubIssueOperationError } from "@t3tools/contracts";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubIssueService from "./GitHubIssueService.ts";
import * as ThreadIssueSyncReactor from "./ThreadIssueSyncReactor.fork.ts";
import { listLinkedIssueThreadsFork } from "./linkedThreads.fork.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

type ObserveRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

type GitHubIssues = typeof GitHubIssueService.GitHubIssueService.Service;

/**
 * Spread into the upstream WS RPC handler table through the marked hook
 * `github-issues/ws-rpc-handlers` in `ws.ts`.
 */
export const gitHubIssueRpcHandlersFork = (
  githubIssues: GitHubIssues,
  observeRpcEffect: ObserveRpcEffect,
  sql: SqlClient.SqlClient,
) => ({
  "githubIssues.list": (input: GitHubIssueListInput) =>
    observeRpcEffect("githubIssues.list", githubIssues.list(input), {
      "rpc.aggregate": "github-issues",
    }),
  "githubIssues.detail": (input: GitHubIssueRef) =>
    observeRpcEffect("githubIssues.detail", githubIssues.detail(input), {
      "rpc.aggregate": "github-issues",
    }),
  "githubIssues.linkedThreads": (input: ThreadIssueKey) =>
    observeRpcEffect(
      "githubIssues.linkedThreads",
      listLinkedIssueThreadsFork(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      { "rpc.aggregate": "github-issues" },
    ),
  "githubIssues.setState": (input: GitHubIssueSetStateInput) =>
    observeRpcEffect("githubIssues.setState", githubIssues.setState(input), {
      "rpc.aggregate": "github-issues",
    }),
  // An active thread only: an unknown or deleted one answers not found.
  "githubIssues.syncThreadLinks": (input: ThreadIssueSyncInput) =>
    observeRpcEffect(
      "githubIssues.syncThreadLinks",
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
      { "rpc.aggregate": "github-issues" },
    ),
});

/**
 * The upstream-shaped service layer, composed with its own dependencies. The
 * project list and repository identities come from the server runtime.
 */
export const gitHubIssueServiceLiveFork = GitHubIssueService.layer.pipe(
  Layer.provide(GitHubCli.layer),
  Layer.provide(VcsProcess.layer),
);

/**
 * Linked issue reads on link, panel open, and refresh, joined to the runtime
 * core through `github-issues/server-issue-sync-reactor` in `server.ts`. The
 * same layer value as the routes' service, so both share one instance.
 */
export const threadIssueSyncReactorLiveFork = ThreadIssueSyncReactor.layer.pipe(
  Layer.provide(gitHubIssueServiceLiveFork),
);
