import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  EnvironmentId,
  type ThreadGroupMutationFork,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { ThreadGroupTitleLoader } from "./threadGroupTitleHttp.ts";
import { createThreadGroupEnvironmentAtoms } from "./threadGroups.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

describe("thread group edits", () => {
  it.effect("send one at a time per environment, in the order made", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const firstSent = yield* Deferred.make<void>();
      const replies = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: { environmentId: ENVIRONMENT_ID },
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.threadGroupsMutateFork]: (mutation: ThreadGroupMutationFork) =>
                Effect.gen(function* () {
                  const title = mutation.type === "rename" ? mutation.title : "";
                  const call = events.filter((event) => event.startsWith("sent")).length;
                  events.push(`sent ${title}`);
                  yield* Deferred.succeed(firstSent, undefined);
                  yield* Deferred.await(replies[call]!);
                  events.push(`answered ${title}`);
                  return { epoch: "run-1", revision: call + 1, groups: [] };
                }),
            },
          } as unknown as RpcSession),
        ),
        state: yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
      } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
            run: (_environmentId, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
            followStream: (_environmentId, stream) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          Layer.succeed(ThreadGroupTitleLoader, {} as ThreadGroupTitleLoader["Service"]),
        ),
      );
      const { mutate } = createThreadGroupEnvironmentAtoms(runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      registry.set(
        sessions(ENVIRONMENT_ID),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable" as const,
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthOrchestrationOperateScope],
          permissions: [AuthOrchestrationOperateScope],
        }),
      );
      const rename = (title: string) =>
        mutate.run(registry, {
          environmentId: ENVIRONMENT_ID,
          input: { type: "rename", groupId: "g1", title } as ThreadGroupMutationFork,
        });

      const first = rename("First");
      const second = rename("Second");
      yield* Deferred.await(firstSent);
      yield* Deferred.succeed(replies[0]!, undefined);
      expect(yield* Effect.promise(() => first)).toMatchObject({ _tag: "Success" });
      yield* Deferred.succeed(replies[1]!, undefined);
      expect(yield* Effect.promise(() => second)).toMatchObject({ _tag: "Success" });
      // The second waits for the first reply, so the server applies them in order.
      expect(events).toEqual(["sent First", "answered First", "sent Second", "answered Second"]);
    }).pipe(Effect.scoped),
  );
});
