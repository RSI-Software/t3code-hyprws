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
import * as Option from "effect/Option";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
      Effect.flatMap(ProjectionSnapshotQuery.ProjectionSnapshotQuery, (snapshots) =>
        snapshots.getThreadShellById(input.threadId),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubIssueOperationError({
              operation: "syncThreadLinks",
              detail: "The thread could not be read.",
              cause,
            }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new GitHubIssueOperationError({
                  operation: "syncThreadLinks",
                  detail: `Thread ${input.threadId} was not found.`,
                }),
              ),
            onSome: (thread) =>
              Effect.flatMap(ThreadIssueSyncReactor.ThreadIssueSyncReactor, (sync) =>
                sync.syncThread(thread, input.scope),
              ),
          }),
        ),
      ),
      { "rpc.aggregate": "github-issues" },
    ),
});

/** The upstream-shaped service layer, composed with its own dependencies. */
export const gitHubIssueServiceLiveFork = GitHubIssueService.layer.pipe(
  Layer.provide(GitHubCli.layer),
  Layer.provide(VcsProcess.layer),
);
