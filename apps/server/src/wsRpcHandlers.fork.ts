// Fork-only: the fork's WS RPC handlers, spread into upstream's handler table in `ws.ts`
// (`upstream-fixes/ws-rpc-handlers`). Upstream registers that table as two smaller groups to stay
// under TypeScript's instantiation limit, so the fork's handlers ride the same table.
import * as Effect from "effect/Effect";
import { RpcGroup } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";
import { RpcScopeAuthorization, wsRpcsFork } from "@t3tools/contracts";

import { ColleagueSharesFork } from "./colleague/ColleagueShares.fork.ts";
import * as CheckoutMoveFork from "./git/CheckoutMoveService.fork.ts";
import * as GitHubIssueService from "./githubIssue/GitHubIssueService.ts";
import { gitHubIssueRpcHandlersFork } from "./githubIssue/githubIssueWiring.fork.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ThreadGroups from "./orchestration-v2/ThreadGroupsService.fork.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";

// The middleware only types the handlers; `RpcServer.make` runs upstream's full group, whose
// middleware wraps these RPCs too.
const WsRpcGroupFork = RpcGroup.make(...wsRpcsFork)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

export const makeWsRpcHandlersFork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const githubIssues = yield* GitHubIssueService.GitHubIssueService;
  const checkoutMoves = yield* CheckoutMoveFork.CheckoutMoveServiceFork;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const threadGroups = yield* ThreadGroups.ThreadGroupsServiceFork;
  const colleagues = yield* ColleagueSharesFork;
  return WsRpcGroupFork.of({
    ...gitHubIssueRpcHandlersFork(githubIssues, sql),
    ...CheckoutMoveFork.checkoutMoveRpcHandlersFork(checkoutMoves),
    "pullRequests.createAttachmentUploadUrl": (input) =>
      pullRequests.createAttachmentUploadUrl(input),
    "pullRequests.uploadAttachment": (input) => pullRequests.uploadAttachment(input),
    "pullRequests.subscribeActivityRefreshesFork": () =>
      pullRequests.subscribeActivityRefreshesFork,
    "threadGroups.subscribeFork": () => threadGroups.changes,
    "threadGroups.mutateFork": (mutation) => threadGroups.mutate(mutation),
    "colleague.shareThreadFork": (input) => colleagues.share(input),
    "colleague.threadSharesFork": (input) => colleagues.threadShares(input.threadId),
    "colleague.unshareThreadFork": (input) => colleagues.unshare(input),
  });
});
