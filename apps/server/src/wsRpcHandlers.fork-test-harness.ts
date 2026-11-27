// Fork-only: the services the fork's WS handlers need, mocked for upstream tests that build
// `layerWsRpc` without exercising a fork RPC.
import * as Layer from "effect/Layer";

import { CollaboratorSharesFork } from "./collaborator/CollaboratorShares.fork.ts";
import { ColleaguesFork } from "./collaborator/Colleagues.fork.ts";
import { ColleagueThreadForkFork } from "./collaborator/ColleagueThreadFork.fork.ts";
import { CheckoutMutationCoordinator } from "./git/CheckoutMutationCoordinator.ts";
import * as CheckoutMoveFork from "./git/CheckoutMoveService.fork.ts";
import * as ThreadGroups from "./orchestration-v2/ThreadGroupsService.fork.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";

export const layerUnusedWsRpcServicesFork = Layer.mergeAll(
  Layer.mock(CheckoutMoveFork.CheckoutMoveServiceFork)({}),
  // The shared-checkout branch guard wraps every WS session's VCS handlers.
  Layer.mock(CheckoutMutationCoordinator)({}),
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
  Layer.mock(ThreadGroups.ThreadGroupsServiceFork)({}),
  Layer.mock(ColleaguesFork)({}),
  Layer.mock(ColleagueThreadForkFork)({}),
  Layer.mock(CollaboratorSharesFork)({
    wrapHandlers: (_subject, handlers) => handlers,
    guardRpc: () => (self) => self,
    isShared: () => false,
    nameOf: () => undefined,
    sharesLive: () => false,
    messageHandlers: () => {
      throw new Error("No test sends a collaborator message RPC through this harness.");
    },
    typingHandlers: () => {
      throw new Error("No test sends a collaborator typing RPC through this harness.");
    },
  }),
);
