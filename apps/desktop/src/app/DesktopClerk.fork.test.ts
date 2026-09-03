import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { beforeEach, vi } from "vite-plus/test";
const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));
vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));
vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
const makeDesktopClerkLayer = (isDevelopment = true, events: string[] = []) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    userDataDirName: isDevelopment ? "t3code-dev" : "t3code",
    legacyUserDataDirName: isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
  );
};
describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
  });
  it.effect("routes Linux second-instance deep links and macOS open-url arguments", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];
    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const openedArguments: string[][] = [];
      const exit = yield* Effect.exit(
        Effect.scoped(
          clerk.configure((argv) =>
            Effect.sync(() => {
              openedArguments.push([...argv]);
            }),
          ),
        ),
      );
      listeners.get("second-instance")?.({}, [
        "/repo/apps/desktop/node_modules/electron/dist/electron",
        "--no-sandbox",
        "dist-electron/main.cjs",
        "t3code-dev://app/project/env/project",
      ]);
      const preventDefault = vi.fn();
      listeners.get("open-url")?.({ preventDefault }, "t3code://app/project/env/project");
      yield* Effect.yieldNow;
      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["second-instance", "open-url"]);
      assert.deepEqual(openedArguments, [
        [
          "/repo/apps/desktop/node_modules/electron/dist/electron",
          "--no-sandbox",
          "dist-electron/main.cjs",
          "t3code-dev://app/project/env/project",
        ],
        ["t3code://app/project/env/project"],
      ]);
      assert.equal(preventDefault.mock.calls.length, 1);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });
  it.effect("logs launch-argument failures with their source and argv", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];
    const records: Array<{
      readonly message: unknown;
      readonly annotations: Readonly<Record<string, unknown>>;
    }> = [];
    const logger = Logger.make(({ fiber, message }) => {
      records.push({
        message,
        annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      });
    });
    const argv = ["electron", "--project=env/project"];
    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(
        Effect.scoped(clerk.configure(() => Effect.fail("window open failed"))),
      );
      listeners.get("second-instance")?.({}, argv);
      yield* Effect.yieldNow;
      assert.isTrue(Exit.isSuccess(exit));
      const warning = records.find(
        (record) =>
          Array.isArray(record.message) && record.message[0] === "failed to open launch arguments",
      );
      assert.isDefined(warning);
      assert.equal(warning.annotations.component, "desktop-clerk");
      assert.equal(warning.annotations.source, "second-instance");
      assert.deepEqual(warning.annotations.argv, argv);
      assert.include(String(warning.annotations.error), "window open failed");
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });
});
