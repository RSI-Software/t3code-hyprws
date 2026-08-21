import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
  projectWindowPreloadArgument,
  readProjectWindowPreloadRef,
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
  } as unknown as Electron.BrowserWindow & {
    readonly __emit: (event: string) => void;
  };
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
  it("round-trips the scoped project through the preload argument", () => {
    const projectRef = {
      environmentId: EnvironmentId.make("environment:remote"),
      projectId: ProjectId.make("project one"),
    };
    const argument = projectWindowPreloadArgument(projectRef);
    assert.isTrue(isProjectWindowPreload(["electron", argument]));
    assert.deepEqual(readProjectWindowPreloadRef(["electron", argument]), projectRef);
    assert.isNull(readProjectWindowPreloadRef(["electron"]));
    assert.isNull(readProjectWindowPreloadRef(["electron", PROJECT_WINDOW_PRELOAD_ARGUMENT]));
  });
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
});
