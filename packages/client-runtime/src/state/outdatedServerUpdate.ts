import type { EnvironmentId, ServerSelfUpdateInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as HttpClient from "effect/http/HttpClient";
import type { Atom, AtomRegistry } from "effect/reactivity";
import type * as Socket from "effect/socket/Socket";

import { updateOutdatedHost } from "../connection/outdatedHostUpdate.ts";
import type * as ConnectionResolver from "../connection/resolver.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import { createAtomCommandScheduler, createRuntimeCommand } from "./runtime.ts";
import {
  serverUpdateFailureMessage,
  serverUpdateStateAtom,
  type ServerUpdateStage,
} from "./server.ts";

export interface OutdatedServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ServerSelfUpdateInput;
  /** From the host descriptor when known; an outdated host never delivers a server config. */
  readonly fromVersion?: string;
}

export function createOutdatedServerUpdateCommand<E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | ConnectionResolver.ConnectionResolver
    | RelayEnvironmentDiscovery.RelayEnvironmentDiscovery
    | Socket.WebSocketConstructor
    | HttpClient.HttpClient,
    E
  >,
) {
  return createRuntimeCommand(runtime, {
    label: "environment-data:server:update-outdated-server",
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId }: OutdatedServerUpdateTarget) => environmentId,
    },
    execute: (target: OutdatedServerUpdateTarget, atomRegistry) =>
      trackOutdatedServerUpdate(atomRegistry, target, (onStage) =>
        updateOutdatedHost(target.environmentId, target.input, onStage),
      ),
  });
}

/** Publishes an outdated-host update's lifecycle to the shared update state. */
export function trackOutdatedServerUpdate<A extends { readonly targetVersion: string }, E, R>(
  atomRegistry: AtomRegistry.AtomRegistry,
  target: OutdatedServerUpdateTarget,
  update: (onStage: (stage: ServerUpdateStage) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
) {
  const stateAtom = serverUpdateStateAtom(target.environmentId);
  const targetVersion = target.input.targetVersion;
  const fromVersion = target.fromVersion ?? targetVersion;
  let currentStage: ServerUpdateStage = "downloading";
  let restartStartedAt: number | undefined;
  const setStage = (stage: ServerUpdateStage) =>
    Effect.gen(function* () {
      currentStage = stage;
      // The host is never connected through the registry, so its downtime
      // starts when the bare update transport hands off to "resuming".
      if (stage === "resuming") restartStartedAt ??= yield* Clock.currentTimeMillis;
      atomRegistry.set(stateAtom, {
        status: "running",
        stage,
        fromVersion,
        targetVersion,
        ...(restartStartedAt === undefined ? {} : { restartStartedAt }),
      });
    });
  return setStage(currentStage).pipe(
    Effect.andThen(update(setStage)),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit)) {
          // Verified against the live descriptor; config may still trail it.
          atomRegistry.set(stateAtom, {
            status: "completed",
            fromVersion,
            targetVersion: exit.value.targetVersion,
          });
          return;
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          atomRegistry.set(stateAtom, { status: "idle" });
          return;
        }
        atomRegistry.set(stateAtom, {
          status: "failed",
          stage: currentStage,
          fromVersion,
          targetVersion,
          message: serverUpdateFailureMessage(Cause.squash(exit.cause)),
        });
      }),
    ),
  );
}
