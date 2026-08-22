import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { appFocusMock, browserWindowMock, getAllWindowsMock, getFocusedWindowMock } = vi.hoisted(
  () => ({
    appFocusMock: vi.fn(),
    browserWindowMock: vi.fn(function BrowserWindowMock() {}),
    getAllWindowsMock: vi.fn(),
    getFocusedWindowMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: Object.assign(browserWindowMock, {
    getAllWindows: getAllWindowsMock,
    getFocusedWindow: getFocusedWindowMock,
  }),
}));

import * as ElectronWindow from "./ElectronWindow.ts";
import {
  HUB_WINDOW_IDENTITY,
  PROJECT_WINDOW_PRELOAD_ARGUMENT,
  isProjectWindowPreload,
  projectWindowIdentity,
} from "../window/WindowIdentity.ts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

const TestLayer = ElectronWindow.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

function makeBrowserWindow(input: { readonly id: number; readonly destroyed: boolean }) {
  const listeners = new Map<string, () => void>();
  return {
    id: input.id,
    isDestroyed: vi.fn(() => input.destroyed),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    close: vi.fn(() => listeners.get("closed")?.()),
    __emit: (event: string) => listeners.get(event)?.(),
  } as unknown as Electron.BrowserWindow & { readonly __emit: (event: string) => void };
}

describe("ElectronWindow", () => {
  beforeEach(() => {
    appFocusMock.mockReset();
    browserWindowMock.mockReset();
    getAllWindowsMock.mockReset();
    getFocusedWindowMock.mockReset();
  });

  it("identifies project-window preload arguments", () => {
    assert.isTrue(isProjectWindowPreload(["electron", PROJECT_WINDOW_PRELOAD_ARGUMENT]));
    assert.isFalse(isProjectWindowPreload(["electron"]));
  });

  it.effect("preserves schema-safe creation context and the Electron cause", () =>
    Effect.gen(function* () {
      const cause = new Error("native BrowserWindow construction failed");
      browserWindowMock.mockImplementationOnce(function BrowserWindowFailure() {
        throw cause;
      });
      const options = {
        title: "T3 Code",
        width: 1100,
        height: 780,
        minWidth: 840,
        minHeight: 620,
        show: false,
        modal: false,
        frame: true,
        transparent: false,
        backgroundColor: "#101010",
        icon: {} as Electron.NativeImage,
        webPreferences: {
          preload: "/tmp/preload.js",
          partition: "persist:t3code-preview-test",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
          spellcheck: true,
        },
      } satisfies Electron.BrowserWindowConstructorOptions;
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      const error = yield* electronWindow.create(options).pipe(Effect.flip);

      assert.instanceOf(error, ElectronWindow.ElectronWindowCreateError);
      assert.isTrue(ElectronWindow.isElectronWindowCreateError(error));
      assert.deepEqual(error.options, {
        title: "T3 Code",
        width: 1100,
        height: 780,
        minWidth: 840,
        minHeight: 620,
        show: false,
        modal: false,
        frame: true,
        transparent: false,
        backgroundColor: "#101010",
        webPreferences: {
          preload: "/tmp/preload.js",
          partition: "persist:t3code-preview-test",
          backgroundThrottling: null,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
        },
      });
      assert.isFalse("icon" in error.options);
      assert.isFalse("spellcheck" in error.options.webPreferences);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to create Electron BrowserWindow "T3 Code" (1100x780).');
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(browserWindowMock.mock.calls, [[options]]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("creates one window per identity and reuses duplicate opens", () =>
    Effect.gen(function* () {
      const projectIdentity = projectWindowIdentity(
        EnvironmentId.make("environment-1"),
        ProjectId.make("project-1"),
      );
      const projectWindow = makeBrowserWindow({ id: 10, destroyed: false });
      const duplicateWindow = makeBrowserWindow({ id: 11, destroyed: false });
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      const created = yield* electronWindow.getOrCreate(
        projectIdentity,
        Effect.succeed(projectWindow),
      );
      const reused = yield* electronWindow.getOrCreate(
        projectIdentity,
        Effect.succeed(duplicateWindow),
      );

      assert.isTrue(created.created);
      assert.isFalse(reused.created);
      assert.strictEqual(reused.window, projectWindow);
      assert.deepEqual(yield* electronWindow.get(projectIdentity), Option.some(projectWindow));
      assert.deepEqual(
        yield* electronWindow.identityFor(projectWindow),
        Option.some(projectIdentity),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("closes identities and removes windows destroyed externally", () =>
    Effect.gen(function* () {
      const projectIdentity = projectWindowIdentity(
        EnvironmentId.make("environment-1"),
        ProjectId.make("project-1"),
      );
      const projectWindow = makeBrowserWindow({ id: 12, destroyed: false });
      const hubWindow = makeBrowserWindow({ id: 13, destroyed: false });
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.getOrCreate(projectIdentity, Effect.succeed(projectWindow));
      yield* electronWindow.getOrCreate(HUB_WINDOW_IDENTITY, Effect.succeed(hubWindow));
      projectWindow.__emit("closed");

      assert.isTrue(Option.isNone(yield* electronWindow.get(projectIdentity)));
      assert.isTrue(Option.isSome(yield* electronWindow.get(HUB_WINDOW_IDENTITY)));

      yield* electronWindow.close(HUB_WINDOW_IDENTITY);
      assert.equal(vi.mocked(hubWindow.close).mock.calls.length, 1);
      assert.isTrue(Option.isNone(yield* electronWindow.get(HUB_WINDOW_IDENTITY)));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("skips windows destroyed before appearance sync runs", () =>
    Effect.gen(function* () {
      const liveWindow = makeBrowserWindow({ id: 1, destroyed: false });
      const destroyedWindow = makeBrowserWindow({ id: 2, destroyed: true });
      getAllWindowsMock.mockReturnValue([destroyedWindow, liveWindow]);

      const syncedWindows: Electron.BrowserWindow[] = [];
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.syncAllAppearance((window) =>
        Effect.sync(() => {
          syncedWindows.push(window);
        }),
      );

      assert.deepEqual(syncedWindows, [liveWindow]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves window enumeration failures as structured defects", () =>
    Effect.gen(function* () {
      const cause = new Error("window enumeration failed");
      getAllWindowsMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.currentMainOrFirst);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "list-windows");
        assert.equal(error.platform, "linux");
        assert.isNull(error.windowId);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
        assert.notInclude(error.message, cause.message);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves reveal failures with the target window", () =>
    Effect.gen(function* () {
      const cause = new Error("window restore failed");
      const window = {
        id: 41,
        isDestroyed: vi.fn(() => false),
        isMinimized: vi.fn(() => true),
        restore: vi.fn(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.reveal(window));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "reveal-window");
        assert.equal(error.windowId, 41);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves message delivery failures with window and channel context", () =>
    Effect.gen(function* () {
      const cause = new Error("renderer send failed");
      const window = {
        id: 42,
        isDestroyed: vi.fn(() => false),
        webContents: {
          send: vi.fn(() => {
            throw cause;
          }),
        },
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.sendAll("desktop:update", { ready: true }));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "send-window-message");
        assert.equal(error.windowId, 42);
        assert.equal(error.channel, "desktop:update");
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves destroy failures and continues with later windows", () =>
    Effect.gen(function* () {
      const cause = new Error("window destroy failed");
      const window = {
        id: 43,
        destroy: vi.fn(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;
      const laterWindow = {
        id: 44,
        destroy: vi.fn(),
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window, laterWindow]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.destroyAll);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "destroy-window");
        assert.equal(error.windowId, 43);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
      assert.equal(vi.mocked(laterWindow.destroy).mock.calls.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );
});
