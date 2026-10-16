import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/** Kept apart from turn refreshes, which never signal expensive activity reads. */
export function createPullRequestActivityRefreshAtomFamilyFork<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:activity-refreshes",
    tag: WS_METHODS.pullRequestsSubscribeActivityRefreshesFork,
  });
}
