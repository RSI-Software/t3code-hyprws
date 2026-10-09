import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { DEFAULT_VOICE_DUCKING_SETTINGS_FORK } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { ElectronApp } from "../electron/ElectronApp.ts";
import { ElectronTheme } from "../electron/ElectronTheme.ts";
import { ElectronWindow } from "../electron/ElectronWindow.ts";
import { DesktopWindow } from "../window/DesktopWindow.ts";
import * as DesktopVoiceDucking from "./DesktopVoiceDucking.fork.ts";

const audio = vi.hoisted(() => ({ list: vi.fn(), setVolumes: vi.fn() }));
vi.mock("./audioOutputs.fork.ts", () => ({ linuxAudioOutputsFork: audio }));
vi.mock("electron", () => ({
  webContents: {
    fromId: () => ({
      isDestroyed: () => false,
      once: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    }),
  },
}));

it.effect("holds Electron quit until pending speaker restoration completes", () =>
  Effect.gen(function* () {
    const original = [60000, 30000];
    let volumes = original;
    const restoring = Promise.withResolvers<void>();
    const allowRestore = Promise.withResolvers<void>();
    const ready = yield* Deferred.make<void>();
    const quit = yield* Deferred.make<void>();
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    audio.list.mockImplementation(async () => [
      { id: "speakers", label: "Speakers", isDefault: true, volumes: [...volumes] },
    ]);
    audio.setVolumes.mockImplementation(async (_id: string, next: readonly number[]) => {
      if (next[0] === original[0]) {
        restoring.resolve();
        await allowRestore.promise;
      }
      volumes = [...next];
      return volumes;
    });
    const environment = Layer.succeed(DesktopEnvironment, {
      platform: "linux",
    } as DesktopEnvironment["Service"]);
    const layer = Layer.mergeAll(
      DesktopVoiceDucking.layer.pipe(Layer.provide(environment)),
      DesktopLifecycle.layer,
      DesktopShutdown.layer,
      DesktopState.layer,
      environment,
      Layer.mock(ElectronApp)({
        on: (event, listener) =>
          Effect.sync(() => {
            listeners.set(event, listener as unknown as (...args: readonly unknown[]) => void);
          }),
        onBeforeQuitForUpdate: () => Effect.void,
        quit: Effect.sync(() => assert.deepEqual(volumes, original)).pipe(
          Effect.andThen(Deferred.succeed(quit, undefined)),
          Effect.asVoid,
        ),
      }),
      Layer.mock(ElectronTheme)({ onUpdated: () => Effect.void }),
      Layer.mock(ElectronWindow)({ destroyAll: Effect.void }),
      Layer.mock(DesktopWindow)({ flushMainWindowBounds: Effect.void }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        const ducking = yield* DesktopVoiceDucking.DesktopVoiceDuckingFork;
        yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
        yield* ducking.start(1, "recording", {
          ...DEFAULT_VOICE_DUCKING_SETTINGS_FORK,
          enabled: true,
        });
        const program = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => shutdown.markComplete);
              yield* DesktopVoiceDucking.registerShutdown;
              yield* Deferred.succeed(ready, undefined);
              yield* shutdown.awaitRequest;
            }),
          ),
        );
        yield* Deferred.await(ready);
        let prevented = false;
        listeners.get("before-quit")!({
          preventDefault: () => {
            prevented = true;
          },
        } as Electron.Event);
        yield* Effect.promise(() => restoring.promise);
        assert.isTrue(prevented);
        assert.isFalse(yield* shutdown.isComplete);
        assert.isFalse(yield* Deferred.isDone(quit));
        assert.deepEqual(volumes, [12000, 6000]);
        allowRestore.resolve();
        yield* Deferred.await(quit);
        yield* Fiber.join(program);
        assert.isTrue(yield* shutdown.isComplete);
        assert.deepEqual(volumes, original);
      }),
    ).pipe(Effect.provide(layer));
  }),
);
