// Fork-only: the services the fork's WS handlers need, mocked for upstream tests that build
// `layerWsRpc` without exercising a fork RPC.
import * as Layer from "effect/Layer";

import * as CheckoutMoveFork from "./git/CheckoutMoveService.fork.ts";
import * as GitHubIssueService from "./githubIssue/GitHubIssueService.ts";
import * as ThreadIssueSyncReactor from "./githubIssue/ThreadIssueSyncReactor.fork.ts";

export const layerUnusedWsRpcServicesFork = Layer.mergeAll(
  Layer.mock(CheckoutMoveFork.CheckoutMoveServiceFork)({}),
  Layer.mock(GitHubIssueService.GitHubIssueService)({}),
  Layer.mock(ThreadIssueSyncReactor.ThreadIssueSyncReactor)({}),
);
