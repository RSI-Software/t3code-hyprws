import { type ThreadGroupTitleGenerationInput, WS_METHODS } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { ThreadGroupTitleLoader } from "./threadGroupTitleHttp.ts";

export { ThreadGroupTitleLoader, threadGroupTitleLoaderLayer } from "./threadGroupTitleHttp.ts";

/** @public Required to name the error in consumers' inferred environment results. */
export class ThreadGroupTitleConnectionNotReadyError extends Data.TaggedError(
  "ThreadGroupTitleConnectionNotReadyError",
)<{ readonly message: string }> {}

export function createThreadGroupEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ThreadGroupTitleLoader | R, E>,
) {
  return {
    /** The environment's groups (fork), then one snapshot per committed change. */
    groups: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-groups:subscribe",
      tag: WS_METHODS.threadGroupsSubscribeFork,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-groups:mutate",
      tag: WS_METHODS.threadGroupsMutateFork,
      // One edit at a time per environment, so replies arrive in the order sent
      // and an older pending edit never replays over a newer answer.
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    generateTitle: createEnvironmentCommand(runtime, {
      label: "environment-data:thread-groups:generate-title",
      execute: Effect.fn("threadGroups.execute")(function* (
        input: ThreadGroupTitleGenerationInput,
      ) {
        const supervisor = yield* EnvironmentSupervisor;
        const loader = yield* ThreadGroupTitleLoader;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          return yield* new ThreadGroupTitleConnectionNotReadyError({
            message: "The environment HTTP connection is not ready.",
          });
        }
        return yield* loader.generate(prepared.value, input);
      }),
    }),
  };
}
