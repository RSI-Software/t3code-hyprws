// Fork-only: the fork's WS RPC handlers, spread into upstream's handler table in `ws.ts`
// (`upstream-fixes/ws-rpc-handlers`). Upstream registers that table as two smaller groups to stay
// under TypeScript's instantiation limit, so the fork's handlers ride the same table.
import * as Effect from "effect/Effect";
import { RpcGroup } from "effect/rpc";
import { type AuthSessionId, RpcScopeAuthorization, wsRpcsFork } from "@t3tools/contracts";

import * as CollaboratorShares from "./collaborator/CollaboratorShares.fork.ts";
import * as Colleagues from "./collaborator/Colleagues.fork.ts";
import * as ColleagueThreadFork from "./collaborator/ColleagueThreadFork.fork.ts";
import * as CheckoutMoveFork from "./git/CheckoutMoveService.fork.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ThreadGroups from "./orchestration-v2/ThreadGroupsService.fork.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";

// The middleware only types the handlers; `RpcServer.make` runs upstream's full group, whose
// middleware wraps these RPCs too.
const WsRpcGroupFork = RpcGroup.make(...wsRpcsFork)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

export const makeWsRpcHandlersFork = Effect.fn("makeWsRpcHandlersFork")(function* (session: {
  readonly subject: string;
  readonly sessionId: AuthSessionId;
}) {
  const checkoutMoves = yield* CheckoutMoveFork.CheckoutMoveServiceFork;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const threadGroups = yield* ThreadGroups.ThreadGroupsServiceFork;
  const collaborators = yield* CollaboratorShares.CollaboratorSharesFork;
  const colleagues = yield* Colleagues.ColleaguesFork;
  const colleagueThreads = yield* ColleagueThreadFork.ColleagueThreadForkFork;
  return WsRpcGroupFork.of({
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
    "collaborator.setTypingFork": (input) =>
      collaborators.typingHandlers(null)["collaborator.setTypingFork"](input),
    "collaborator.subscribeTypingFork": (input) =>
      collaborators.typingHandlers(null)["collaborator.subscribeTypingFork"](input),
    "colleague.inviteFork": (input) => colleagues.invite(input),
    "colleague.saveFork": (input) => colleagues.save(session, input),
    "colleague.connectFork": (input) => colleagues.connect(input),
    "colleague.subscribeFork": () => colleagues.changes,
    "colleague.removeFork": (input) => colleagues.remove(input.subject),
    "colleague.pairClientFork": (input) => colleagues.pairClient(input.subject),
    "colleague.shareThreadFork": (input) => colleagues.shareThread(input),
    "colleague.subscribeOutboxFork": () => colleagues.outbox,
    "colleague.queueMessageFork": (input) => colleagues.queueMessage(input),
    "colleague.unqueueMessageFork": (input) => colleagues.unqueueMessage(input.id),
    "colleague.forkThreadFork": (input) => colleagueThreads.fork(input),
  });
});
