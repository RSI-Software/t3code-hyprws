import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  environmentRpcKey,
  createAtomCommandScheduler,
  createEnvironmentQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  createRuntimeCommand,
  scheduleAtomCommandEffect,
  executeAtomCommand,
  executeAtomQuery,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "./runtime.ts";
const QUERY_ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("query-environment"),
  label: "Query environment",
  httpBaseUrl: "https://query.example.test",
  wsBaseUrl: "wss://query.example.test",
});
const QUERY_RPC_SESSION = {} as RpcSession.RpcSession;
class TestQueryError extends Schema.TaggedErrorClass<TestQueryError>()("TestQueryError", {
  message: Schema.String,
}) {}
const OFFLINE_QUERY_FAILURE = new ConnectionTransientError({
  reason: "transport",
  detail: "Relay is unavailable.",
});
const BLOCKED_QUERY_FAILURE = new ConnectionBlockedError({
  reason: "permission",
  detail: "Access denied.",
});
function queryConnectionState(
  overrides: Partial<SupervisorConnectionState> = {},
): SupervisorConnectionState {
  return {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
    ...overrides,
  };
}
const makeEnvironmentQueryHarness = Effect.fn("TestEnvironmentQuery.makeHarness")(function* <A, E>(
  execute: Effect.Effect<A, E>,
) {
  const supervisorState = yield* SubscriptionRef.make(queryConnectionState());
  const supervisorSession = yield* SubscriptionRef.make(Option.some(QUERY_RPC_SESSION));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: QUERY_ENVIRONMENT,
    state: supervisorState,
    session: supervisorSession,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(supervisorState),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const family = createEnvironmentQueryAtomFamily(runtime, {
    label: "test.environment-query",
    staleTimeMs: 60000,
    execute: () => execute,
  });
  return {
    atom: family({ environmentId: QUERY_ENVIRONMENT.environmentId, input: undefined }),
    supervisorSession,
    supervisorState,
  };
});
const mountEnvironmentQuery = Effect.fn("TestEnvironmentQuery.mount")(function* <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      registry.dispose();
    }),
  );
  return registry;
});
describe("environment subscription lifecycle", () => {
  it.effect("releases a zero-TTL stream as soon as its last consumer unmounts", () =>
    Effect.gen(function* () {
      const started = Latch.makeUnsafe();
      const released = Latch.makeUnsafe();
      const run = ((_environmentId: unknown, effect: unknown) =>
        effect) as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]["run"];
      const runStream = ((_environmentId: unknown, stream: unknown) =>
        stream) as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"];
      const followStream = ((_environmentId: unknown, stream: unknown) =>
        stream) as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"];
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        runStream,
        followStream,
        stateChanges: () => Stream.empty,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      );
      const family = createEnvironmentSubscriptionAtomFamily(runtime, {
        label: "test.immediate-subscription-release",
        idleTtlMs: 0,
        subscribe: (_input: void) =>
          Stream.fromEffect(Effect.sync(() => started.openUnsafe())).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(Effect.sync(() => released.openUnsafe())),
          ),
      });
      const atom = family({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: undefined,
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(atom);
      yield* started.await;
      unmount();
      yield* released.await;
      registry.dispose();
    }),
  );
});
