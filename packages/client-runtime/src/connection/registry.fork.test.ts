import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as TokenStore from "../authorization/tokenStore.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import { PrimaryConnectionRegistration } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import { type ConnectionTarget, PrimaryConnectionTarget, RelayConnectionTarget } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Attached local server",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});

/** Only the stores `registerPlatform` and `reconcilePlatform` touch are live. */
const makeHarness = (initialTargets: ReadonlyArray<ConnectionTarget>) =>
  Effect.gen(function* () {
    const storedTargets = yield* Ref.make(
      new Map(initialTargets.map((target) => [target.environmentId, target])),
    );
    const edit = (change: (next: Map<EnvironmentId, ConnectionTarget>) => void) =>
      Ref.update(storedTargets, (current) => {
        const next = new Map(current);
        change(next);
        return next;
      });
    const network = yield* SubscriptionRef.make<"unknown" | "offline" | "online">("online");
    const layer = EnvironmentRegistry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Persistence.ConnectionTargetStore, {
            list: Ref.get(storedTargets).pipe(Effect.map((targets) => [...targets.values()])),
            listDisabled: Effect.succeed([]),
          }),
          Layer.succeed(Persistence.ConnectionRegistrationStore, {
            register: (registration) =>
              edit((next) => next.set(registration.target.environmentId, registration.target)),
            remove: (target) => edit((next) => next.delete(target.environmentId)),
            setEnabled: () => Effect.void,
          }),
          Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
            get: () => Effect.succeedNone,
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
          Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
            get: () => Effect.succeedNone,
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
          Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
            get: () => Effect.succeedNone,
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
          Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
            provision: () => Effect.die(new Error("SSH is not used.")),
            prepare: () => Effect.die(new Error("SSH is not used.")),
            disconnect: () => Effect.void,
          }),
          Layer.succeed(Connectivity.Connectivity, {
            status: SubscriptionRef.get(network),
            changes: SubscriptionRef.changes(network),
          }),
          Layer.succeed(ConnectionWakeups.ConnectionWakeups, { changes: Stream.never }),
          Layer.succeed(ConnectionDriver.ConnectionDriver, { connect: () => Effect.never }),
          Layer.succeed(Persistence.EnvironmentCacheStore, {
            loadShell: () => Effect.succeedNone,
            saveShell: () => Effect.void,
            loadThread: () => Effect.succeedNone,
            saveThread: () => Effect.void,
            removeThread: () => Effect.void,
            loadServerConfig: () => Effect.succeedNone,
            saveServerConfig: () => Effect.void,
            loadVcsRefs: () => Effect.succeedNone,
            saveVcsRefs: () => Effect.void,
            removeVcsRefs: () => Effect.void,
            clearVcsRefs: () => Effect.void,
            clear: () => Effect.void,
          }),
          Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, { clear: () => Effect.void }),
        ),
      ),
    );
    return { layer, storedTargets };
  });

const withAuth = (savedConnectionsOutrankPrimary: boolean) =>
  Effect.provideService(
    ClientCapabilities.PrimaryEnvironmentAuth,
    ClientCapabilities.PrimaryEnvironmentAuth.of({
      bearerToken: Effect.succeed(Option.none()),
      savedConnectionsOutrankPrimary,
    }),
  );

describe("EnvironmentRegistry saved-connection precedence RSI-Software/t3code-hyprws#1350", () => {
  const savedTarget = new RelayConnectionTarget({
    environmentId: TARGET.environmentId,
    label: "Saved relay environment",
  });

  it.effect("an attaching platform keeps the saved connection over its primary", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([savedTarget]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const targetOf = SubscriptionRef.get(registry.entries).pipe(
          Effect.map((entries) => entries.get(TARGET.environmentId)?.target),
        );
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }));
        expect(yield* targetOf).toEqual(savedTarget);
        // The attachment drops: the saved connection is untouched.
        yield* registry.reconcilePlatform([]);
        expect(yield* targetOf).toEqual(savedTarget);
        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(true);
      }).pipe(Effect.provide(harness.layer), withAuth(true), Effect.scoped);
    }),
  );

  it.effect("without the flag the platform primary still shadows the saved connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([savedTarget]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }));
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
      }).pipe(Effect.provide(harness.layer), withAuth(false), Effect.scoped);
    }),
  );
});
