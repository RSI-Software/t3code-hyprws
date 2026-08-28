import type { ThreadGroupTitleGenerationInput } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import { ThreadGroupTitleLoader } from "./threadGroupTitleHttp.ts";

export { ThreadGroupTitleLoader, threadGroupTitleLoaderLayer } from "./threadGroupTitleHttp.ts";

export class ThreadGroupTitleConnectionNotReadyError extends Data.TaggedError(
  "ThreadGroupTitleConnectionNotReadyError",
)<{ readonly message: string }> {}

export function createThreadGroupEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ThreadGroupTitleLoader | R, E>,
) {
  return {
    generateTitle: createEnvironmentCommand(runtime, {
      label: "environment-data:thread-groups:generate-title",
      execute: (input: ThreadGroupTitleGenerationInput) =>
        Effect.gen(function* () {
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
