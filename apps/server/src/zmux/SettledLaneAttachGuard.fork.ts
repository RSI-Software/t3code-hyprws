import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

/** A settled consumer must not recreate its checkout's released session. */
export class SettledLaneAttachGuard extends Context.Service<
  SettledLaneAttachGuard,
  { readonly isSettledThread: (threadId: string) => Effect.Effect<boolean> }
>()("t3/zmux/SettledLaneAttachGuard.fork/SettledLaneAttachGuard") {}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return SettledLaneAttachGuard.of({
    isSettledThread: (threadId) =>
      projections.getThread(ThreadId.make(threadId)).pipe(
        Effect.map((thread) => thread.settledOverride === "settled"),
        // An unreadable thread is not permission to create a managed session.
        Effect.catch((error) =>
          Effect.logWarning("could not verify terminal thread settlement", {
            threadId,
            detail: error.message,
          }).pipe(Effect.as(true)),
        ),
      ),
  });
});

export const layer = Layer.effect(SettledLaneAttachGuard, make).pipe(
  Layer.provide(ProjectionStore.layer),
);
