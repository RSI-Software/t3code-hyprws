import { EnvironmentId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Atom, AtomRegistry } from "effect/reactivity";
import { it as effectIt } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  publishSettledServerUpdateState,
  ServerUpdateTerminalError,
  serverUpdateFailureMessage,
  serverUpdateRestartElapsedSeconds,
  serverUpdateRestartStartedAt,
  serverUpdateStateAtom,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  type ServerUpdateState,
} from "./server.ts";
import { trackOutdatedServerUpdate } from "./outdatedServerUpdate.ts";
import { serverUpdateRestartLabelFork } from "./serverUpdateBackup.fork.ts";

const versions = { fromVersion: "1.0.0", targetVersion: "1.0.1" };
const restarting = { status: "running", stage: "resuming", ...versions } as const;

afterEach(() => vi.useRealTimers());

describe("server update progress", () => {
  it("starts downtime on the first disconnect, not the click or handoff", () => {
    expect(serverUpdateRestartStartedAt(undefined, "connected", 1000)).toBeUndefined();
    const started = serverUpdateRestartStartedAt(undefined, "backoff", 2200);
    expect(started).toBe(2200);
    for (const phase of ["connecting", "backoff", "connected", "blocked"]) {
      expect(serverUpdateRestartStartedAt(started, phase, 5000)).toBe(2200);
    }
    expect(serverUpdateRestartElapsedSeconds(restarting, 5000)).toBeNull();
    const state = {
      ...restarting,
      ...(started === undefined ? {} : { restartStartedAt: started }),
    };
    expect(serverUpdateRestartElapsedSeconds(state, 2200)).toBe(0);
    expect(serverUpdateRestartElapsedSeconds(state, 3199)).toBe(0);
    expect(serverUpdateRestartElapsedSeconds(state, 3200)).toBe(1);
    expect(serverUpdateRestartElapsedSeconds(state, 63200)).toBe(61);
    expect(serverUpdateRestartElapsedSeconds(state, 1000)).toBe(0);
  });

  it("does not expose a clock outside the restart stage", () => {
    const states: ServerUpdateState[] = [
      { status: "idle" },
      { ...restarting, stage: "downloading", restartStartedAt: 0 },
      { ...restarting, stage: "installing", restartStartedAt: 0 },
      { status: "completed", ...versions },
      { status: "failed", stage: "resuming", ...versions, message: "Timed out" },
    ];
    for (const state of states) expect(serverUpdateRestartElapsedSeconds(state, 10000)).toBeNull();
  });

  it("names the pre-migration backup only while restarting", () => {
    const backingUp = { ...restarting, databaseBackupBytesFork: 20_900_000_000 };
    expect(serverUpdateRestartLabelFork(backingUp, "Restarting…")).toBe(
      "Backing up database (20.9 GB) and restarting…",
    );
    expect(
      serverUpdateRestartLabelFork({ ...restarting, databaseBackupBytesFork: 40_000 }, "x"),
    ).toBe("Backing up database (1 MB) and restarting…");
    expect(serverUpdateRestartLabelFork(restarting, "Restarting…")).toBe("Restarting…");
    expect(
      serverUpdateRestartLabelFork({ ...backingUp, status: "failed", message: "x" }, "Failed"),
    ).toBe("Failed");
  });

  it("uses only real streamed milestones and does not invent byte progress", () => {
    for (const stage of ["downloading", "installing"] as const) {
      const state = serverUpdateStateForProgressEvent(
        versions.fromVersion,
        versions.targetVersion,
        {
          type: "progress",
          stage,
        },
      );
      expect(state.stage).toBe(stage);
      expect(serverUpdateRestartElapsedSeconds(state, 10000)).toBeNull();
    }
    expect(
      serverUpdateStateForProgressEvent(versions.fromVersion, versions.targetVersion, {
        type: "complete",
        result: { targetVersion: versions.targetVersion, method: "respawn" },
      }).stage,
    ).toBe("resuming");
  });

  it("retains the attempt and clock when its last UI subscriber unmounts", () => {
    vi.useFakeTimers();
    const registry = AtomRegistry.make();
    const atom = serverUpdateStateAtom(EnvironmentId.make("progress-remount"));
    const state = { ...restarting, restartStartedAt: 2200 };
    try {
      const unmount = registry.mount(atom);
      registry.set(atom, state);
      unmount();
      vi.runAllTimers();
      expect(registry.get(atom)).toBe(state);
      expect(serverUpdateRestartElapsedSeconds(registry.get(atom), 12200)).toBe(10);
    } finally {
      registry.dispose();
    }
  });

  it("shows a terminal outcome only while the server runs the version it settled on", () => {
    const done = { status: "completed", ...versions } as const;
    // Never read at targetVersion before the server returned to fromVersion.
    expect(serverUpdateStateForServerVersion(done, versions.fromVersion)).toEqual({
      status: "idle",
    });
    for (const version of [null, versions.targetVersion]) {
      expect(serverUpdateStateForServerVersion(done, version)).toBe(done);
    }
    expect(serverUpdateStateForServerVersion(done, "1.0.2")).toEqual({ status: "idle" });

    const error = new ServerUpdateTerminalError({
      targetVersion: versions.targetVersion,
      status: "rolled-back",
      reason: "Health check failed",
    });
    const rolledBack = {
      status: "failed",
      stage: "resuming",
      ...versions,
      message: serverUpdateFailureMessage(error),
    } as const;
    expect(rolledBack.message).toBe("Update rolled back: Health check failed");
    for (const version of [null, versions.fromVersion]) {
      expect(serverUpdateStateForServerVersion(rolledBack, version)).toBe(rolledBack);
    }
    // A later successful update elsewhere.
    expect(serverUpdateStateForServerVersion(rolledBack, versions.targetVersion)).toEqual({
      status: "idle",
    });
  });

  effectIt.effect("publishes an outcome only once config reports its settled version", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const atom = serverUpdateStateAtom(EnvironmentId.make("settle-progress"));
      const config = Atom.make<ServerVersionConfig>(serverVersionConfig(versions.fromVersion)).pipe(
        Atom.keepAlive,
      );
      const publish = (state: Parameters<typeof publishSettledServerUpdateState>[3]) =>
        publishSettledServerUpdateState(registry, atom, config, state).pipe(Effect.forkChild);
      registry.set(atom, restarting);

      const done = { status: "completed", ...versions } as const;
      const completing = yield* publish(done);
      yield* TestClock.adjust(Duration.seconds(1));
      expect(registry.get(atom)).toBe(restarting);
      registry.set(config, serverVersionConfig(versions.targetVersion));
      yield* Fiber.join(completing);
      expect(registry.get(atom)).toBe(done);

      const rolledBack = {
        status: "failed",
        stage: "resuming",
        ...versions,
        message: "Update rolled back: Health check failed",
      } as const;
      const failing = yield* publish(rolledBack);
      yield* TestClock.adjust(Duration.seconds(1));
      expect(registry.get(atom)).toBe(done);
      registry.set(config, serverVersionConfig(versions.fromVersion));
      yield* Fiber.join(failing);
      expect(registry.get(atom)).toBe(rolledBack);

      const lagging = yield* publish(done);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(lagging);
      expect(registry.get(atom)).toBe(done);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("retires a published outcome once the server leaves its version", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const atom = serverUpdateStateAtom(EnvironmentId.make("retire-progress"));
      const config = Atom.make<ServerVersionConfig>(
        serverVersionConfig(versions.targetVersion),
      ).pipe(Atom.keepAlive);
      const publish = (state: Parameters<typeof publishSettledServerUpdateState>[3]) =>
        publishSettledServerUpdateState(registry, atom, config, state);

      const done = { status: "completed", ...versions } as const;
      yield* publish(done);
      expect(registry.get(atom)).toBe(done);
      registry.set(config, serverVersionConfig("1.0.2"));
      registry.set(config, serverVersionConfig(versions.targetVersion));
      expect(registry.get(atom)).toEqual({ status: "idle" });

      const rolledBack = {
        status: "failed",
        stage: "resuming",
        ...versions,
        message: "Update rolled back: Health check failed",
      } as const;
      registry.set(config, serverVersionConfig(versions.fromVersion));
      yield* publish(rolledBack);
      expect(registry.get(atom)).toBe(rolledBack);
      registry.set(config, serverVersionConfig(versions.targetVersion));
      registry.set(config, serverVersionConfig(versions.fromVersion));
      expect(registry.get(atom)).toEqual({ status: "idle" });

      // A newer attempt owns the state; the old watch must not clear it.
      yield* publish(rolledBack);
      registry.set(atom, restarting);
      registry.set(config, serverVersionConfig(versions.targetVersion));
      expect(registry.get(atom)).toBe(restarting);
    }).pipe(Effect.scoped),
  );

  effectIt.effect(
    "clocks an outdated-host restart from the transport handoff and confirms the resumed version",
    () =>
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const environmentId = EnvironmentId.make("outdated-progress");
        const atom = serverUpdateStateAtom(environmentId);
        const target = { environmentId, input: { targetVersion: "1.0.1" }, fromVersion: "1.0.0" };
        const result = yield* trackOutdatedServerUpdate(registry, target, (onStage) =>
          Effect.gen(function* () {
            yield* onStage("installing");
            expect(serverUpdateRestartElapsedSeconds(registry.get(atom), 0)).toBeNull();
            yield* TestClock.adjust(Duration.seconds(5));
            yield* onStage("resuming");
            yield* TestClock.adjust(Duration.seconds(3));
            expect(registry.get(atom)).toMatchObject({ stage: "resuming", restartStartedAt: 5000 });
            expect(serverUpdateRestartElapsedSeconds(registry.get(atom), 8000)).toBe(3);
            return { targetVersion: "1.0.2", method: "respawn" as const };
          }),
        );
        expect(result.targetVersion).toBe("1.0.2");
        expect(registry.get(atom)).toEqual({
          status: "completed",
          fromVersion: "1.0.0",
          targetVersion: "1.0.2",
        });
      }).pipe(Effect.scoped),
  );
});

type ServerVersionConfig = { readonly environment: { readonly serverVersion: string } } | null;

function serverVersionConfig(serverVersion: string): ServerVersionConfig {
  return { environment: { serverVersion } };
}
