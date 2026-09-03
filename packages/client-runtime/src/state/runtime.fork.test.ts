import { describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";
const QUERY_ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("query-environment"),
  label: "Query environment",
  httpBaseUrl: "https://query.example.test",
  wsBaseUrl: "wss://query.example.test",
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
