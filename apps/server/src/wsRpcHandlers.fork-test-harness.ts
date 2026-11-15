// Fork-only: the services the fork's WS handlers need, mocked for upstream tests that build
// `layerWsRpc` without exercising a fork RPC.
import * as Layer from "effect/Layer";

import { CollaboratorSharesFork } from "./collaborator/CollaboratorShares.fork.ts";
import * as CheckoutMoveFork from "./git/CheckoutMoveService.fork.ts";
import * as IssueService from "./issues/IssueService.ts";
import * as ThreadIssueSyncReactor from "./issues/ThreadIssueSyncReactor.fork.ts";
import * as ThreadGroups from "./orchestration-v2/ThreadGroupsService.fork.ts";

export const layerUnusedWsRpcServicesFork = Layer.mergeAll(
  Layer.mock(CheckoutMoveFork.CheckoutMoveServiceFork)({}),
  Layer.mock(IssueService.IssueService)({}),
  Layer.mock(ThreadIssueSyncReactor.ThreadIssueSyncReactor)({}),
  Layer.mock(ThreadGroups.ThreadGroupsServiceFork)({}),
  Layer.mock(CollaboratorSharesFork)({
    wrapHandlers: (_subject, handlers) => handlers,
    guardRpc: () => (self) => self,
    isShared: () => false,
    messageHandlers: () => {
      throw new Error("No test sends a collaborator message RPC through this harness.");
    },
  }),
);
