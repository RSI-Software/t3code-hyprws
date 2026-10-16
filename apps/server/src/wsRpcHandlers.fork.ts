// Fork-only: every fork WS RPC is served from this handler layer, not upstream's handler table in
// `ws.ts`. One table holding upstream's and the fork's handlers exceeds TypeScript's type
// instantiation limit (TS2589), which silently turns the WS layer's requirements into `any`.
// `ws.ts` omits these tags from its table (`upstream-fixes/ws-rpc-handler-group-omit`), shadows
// its group with that one inside the table's layer (`upstream-fixes/ws-rpc-handler-group`), and
// merges this layer beside it (`upstream-fixes/ws-rpc-handlers-layer`).
import * as Effect from "effect/Effect";
import { RpcGroup } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";
import { RpcScopeAuthorization, wsRpcsFork } from "@t3tools/contracts";

import * as CheckoutMoveFork from "./git/CheckoutMoveService.fork.ts";
import * as GitHubIssueService from "./githubIssue/GitHubIssueService.ts";
import { gitHubIssueRpcHandlersFork } from "./githubIssue/githubIssueWiring.fork.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";

export const wsRpcTagsFork = wsRpcsFork.map((rpc) => rpc._tag);

// The middleware only types the handlers; `RpcServer.make` runs upstream's full group, whose
// middleware wraps these RPCs too.
const WsRpcGroupFork = RpcGroup.make(...wsRpcsFork)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

export const wsRpcHandlersLayerFork = WsRpcGroupFork.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const githubIssues = yield* GitHubIssueService.GitHubIssueService;
    const checkoutMoves = yield* CheckoutMoveFork.CheckoutMoveServiceFork;
    const pullRequests = yield* PullRequestService.PullRequestService;
    return WsRpcGroupFork.of({
      ...gitHubIssueRpcHandlersFork(githubIssues, sql),
      ...CheckoutMoveFork.checkoutMoveRpcHandlersFork(checkoutMoves),
      "pullRequests.createAttachmentUploadUrl": (input) =>
        pullRequests.createAttachmentUploadUrl(input),
      "pullRequests.uploadAttachment": (input) => pullRequests.uploadAttachment(input),
    });
  }),
);
