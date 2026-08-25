// Fork-only: GitHub issue RPC handler wiring for commit `9f92309411`
// (feat(issues): add GitHub Issues surface scoped to project windows). The
// upstream `ws.ts` carries only marked hook lines pointing here; the handler
// table entries and the service-layer wiring are spread in through
// `github-issues/ws-rpc-handlers`, `github-issues/server-service-live`, and
// friends.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  EnvironmentAuthorizationError,
  GitHubIssueListInput,
  GitHubIssueRef,
} from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubIssueService from "./GitHubIssueService.ts";
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
) => ({
  "githubIssues.list": (input: GitHubIssueListInput) =>
    observeRpcEffect("githubIssues.list", githubIssues.list(input), {
      "rpc.aggregate": "github-issues",
    }),
  "githubIssues.detail": (input: GitHubIssueRef) =>
    observeRpcEffect("githubIssues.detail", githubIssues.detail(input), {
      "rpc.aggregate": "github-issues",
    }),
});

/** The upstream-shaped service layer, composed with its own dependencies. */
export const gitHubIssueServiceLiveFork = GitHubIssueService.layer.pipe(
  Layer.provide(GitHubCli.layer),
  Layer.provide(VcsProcess.layer),
);
