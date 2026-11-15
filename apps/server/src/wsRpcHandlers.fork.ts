// Fork-only: the fork's WS RPC handlers, spread into upstream's handler table in `ws.ts`
// (`upstream-fixes/ws-rpc-handlers`). Upstream registers that table as two smaller groups to stay
// under TypeScript's instantiation limit, so the fork's handlers ride the same table.
import * as Effect from "effect/Effect";
import { RpcGroup } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";
import { RpcScopeAuthorization, wsRpcsFork } from "@t3tools/contracts";

import * as CollaboratorShares from "./collaborator/CollaboratorShares.fork.ts";
import * as CheckoutMoveFork from "./git/CheckoutMoveService.fork.ts";
import * as IssueService from "./issues/IssueService.ts";
import { issueRpcHandlersFork } from "./issues/issueWiring.fork.ts";
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
  const issueService = yield* IssueService.IssueService;
  const checkoutMoves = yield* CheckoutMoveFork.CheckoutMoveServiceFork;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const threadGroups = yield* ThreadGroups.ThreadGroupsServiceFork;
  const collaborators = yield* CollaboratorShares.CollaboratorSharesFork;
  return WsRpcGroupFork.of({
    ...issueRpcHandlersFork(issueService, sql),
    ...CheckoutMoveFork.checkoutMoveRpcHandlersFork(checkoutMoves),
    "pullRequests.createAttachmentUploadUrl": (input) =>
      pullRequests.createAttachmentUploadUrl(input),
    "pullRequests.uploadAttachment": (input) => pullRequests.uploadAttachment(input),
    "pullRequests.subscribeActivityRefreshesFork": () =>
      pullRequests.subscribeActivityRefreshesFork,
    "threadGroups.subscribeFork": () => threadGroups.changes,
    "threadGroups.mutateFork": (mutation) => threadGroups.mutate(mutation),
    "collaborator.shareThreadFork": (input) => collaborators.share(input),
    "collaborator.threadSharesFork": (input) => collaborators.threadShares(input.threadId),
    "collaborator.unshareThreadFork": (input) => collaborators.unshare(input),
    "collaborator.setAccessFork": (input) => collaborators.setAccess(input),
    "collaborator.subscribeMessagesFork": () =>
      collaborators.messageHandlers(null)["collaborator.subscribeMessagesFork"](),
    "collaborator.submitMessageFork": (input) =>
      collaborators.messageHandlers(null)["collaborator.submitMessageFork"](input),
    "collaborator.resolveMessageFork": (input) =>
      collaborators.messageHandlers(null)["collaborator.resolveMessageFork"](input),
  });
});
