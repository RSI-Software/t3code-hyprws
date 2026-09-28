import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const { getFocusedWindowMock } = vi.hoisted(() => ({ getFocusedWindowMock: vi.fn() }));
vi.mock("electron", () => ({
  app: { focus: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: getFocusedWindowMock,
  }),
}));

import * as DesktopAppActivation from "../app/DesktopAppActivation.ts";
import { DesktopAppActivationBroker } from "../app/DesktopAppActivationBroker.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { setReady } from "../ipc/methods/appActivation.ts";
import {
  DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL,
  GET_WINDOW_FULLSCREEN_STATE_CHANNEL,
} from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { getWindowFullscreenState, pickThemeFiles } from "../ipc/methods/window.ts";
import {
  endSnapShotReveal,
  makePinnedSnapShotDispatch,
  snapShotCaptureTarget,
  withSnapShotRevealTarget,
} from "../snapShot/SnapShotTarget.fork.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { HUB_WINDOW_IDENTITY, projectWindowIdentity } from "../window/WindowIdentity.ts";
import * as ElectronDialog from "./ElectronDialog.ts";
import * as ElectronWindow from "./ElectronWindow.ts";
import { IpcRequester } from "./WindowTargets.fork.ts";

type Listener = (...args: unknown[]) => void;

function makeEmitter() {
  const listeners = new Map<string, Set<Listener>>();
  const add = (event: string, listener: Listener) => {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
  };
  return {
    on: vi.fn((event: string, listener: Listener) => add(event, listener)),
    once: vi.fn((event: string, listener: Listener) => {
      const wrapped: Listener = (...args) => {
        listeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      add(event, wrapped);
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  };
}

let nextId = 1;

/** A BrowserWindow fake with its own webContents, focus, and close events. */
function makeWindow(options: { readonly fullScreen?: boolean } = {}) {
  const id = nextId++;
  let destroyed = false;
  const contentsEvents = makeEmitter();
  const webContents = {
    id: 1000 + id,
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => false,
    send: vi.fn(),
    on: contentsEvents.on,
    once: contentsEvents.once,
    removeListener: contentsEvents.removeListener,
  };
  const windowEvents = makeEmitter();
  const window = {
    id,
    webContents,
    isDestroyed: () => destroyed,
    isFullScreen: () => options.fullScreen ?? false,
    on: windowEvents.on,
    once: windowEvents.once,
    close: () => {
      destroyed = true;
      windowEvents.emit("closed");
      contentsEvents.emit("destroyed");
    },
  };
  return {
    window: window as unknown as Electron.BrowserWindow,
    webContents,
    focus: () => windowEvents.emit("focus"),
    close: window.close,
  };
}

type FakeWindow = ReturnType<typeof makeWindow>;

const ElectronWindowLayer = ElectronWindow.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

const projectIdentity = (projectId: string) =>
  projectWindowIdentity(EnvironmentId.make("environment-1"), ProjectId.make(projectId));

/** Registers a hub and a project window the way main creates them; the project is newer. */
const openHubAndProject = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const hub = makeWindow({ fullScreen: true });
  const project = makeWindow();
  yield* electronWindow.getOrCreate(HUB_WINDOW_IDENTITY, () => Effect.succeed(hub.window));
  yield* electronWindow.getOrCreate(projectIdentity("project-1"), () =>
    Effect.succeed(project.window),
  );
  return { electronWindow, hub, project };
});

const asRequester = (window: FakeWindow) =>
  Effect.provideService(IpcRequester, Option.some(window.webContents.id));

beforeEach(() => {
  getFocusedWindowMock.mockReset();
  getFocusedWindowMock.mockReturnValue(null);
});

describe("window requests resolve to the sender or the most recent window", () => {
  it.effect("an IPC request resolves every main-style lookup to the sending window", () =>
    Effect.gen(function* () {
      const { electronWindow, hub, project } = yield* openHubAndProject;
      hub.focus();
      getFocusedWindowMock.mockReturnValue(hub.window);

      const lookups = Effect.all([
        electronWindow.main,
        electronWindow.currentMainOrFirst,
        electronWindow.focusedMainOrFirst,
      ]);
      for (const window of yield* lookups.pipe(asRequester(project))) {
        assert.strictEqual(Option.getOrNull(window), project.window);
      }
    }).pipe(Effect.provide(ElectronWindowLayer)),
  );

  it.effect("fullscreen state is read from the sender, not the hub", () =>
    Effect.gen(function* () {
      const { hub, project } = yield* openHubAndProject;
      hub.focus();
      let listener: DesktopIpc.DesktopIpcSyncListener | undefined;
      const ipc = DesktopIpc.make({
        removeHandler: vi.fn(),
        handle: vi.fn(),
        removeAllListeners: vi.fn(),
        on: (channel, registered) => {
          if (channel === GET_WINDOW_FULLSCREEN_STATE_CHANNEL) listener = registered;
        },
      });
      yield* Effect.scoped(ipc.handleSync(getWindowFullscreenState));

      const fromProject = {
        sender: { id: project.webContents.id },
        returnValue: undefined as unknown,
      };
      const fromHub = { sender: { id: hub.webContents.id }, returnValue: undefined as unknown };
      listener!(fromProject);
      listener!(fromHub);

      assert.isFalse(fromProject.returnValue);
      assert.isTrue(fromHub.returnValue);
    }).pipe(Effect.provide(ElectronWindowLayer)),
  );

  it.effect("a dialog opened from a window is owned by that window while another has focus", () =>
    Effect.gen(function* () {
      const { hub, project } = yield* openHubAndProject;
      hub.focus();
      getFocusedWindowMock.mockReturnValue(hub.window);
      const owners: Option.Option<Electron.BrowserWindow>[] = [];
      const dialog = ElectronDialog.ElectronDialog.of({
        pickFiles: (input: ElectronDialog.ElectronDialogPickFilesInput) =>
          Effect.sync(() => {
            owners.push(input.owner);
            return [];
          }),
      } as unknown as ElectronDialog.ElectronDialog["Service"]);

      yield* pickThemeFiles
        .handler(undefined, { sender: { id: project.webContents.id } })
        .pipe(Effect.provideService(ElectronDialog.ElectronDialog, dialog));

      assert.deepEqual(owners, [Option.some(project.window)]);
    }).pipe(Effect.provide(Layer.merge(ElectronWindowLayer, NodeServices.layer))),
  );

  it.effect("an app-wide request resolves to the most recently focused app window only", () =>
    Effect.gen(function* () {
      const { electronWindow, hub, project } = yield* openHubAndProject;
      // DevTools, a popup, or the splash can hold focus; none was registered by main.
      const devTools = makeWindow();
      getFocusedWindowMock.mockReturnValue(devTools.window);
      const target = Effect.all([electronWindow.main, electronWindow.focusedMainOrFirst]);

      hub.focus();
      assert.deepEqual(yield* target, [Option.some(hub.window), Option.some(hub.window)]);

      project.focus();
      assert.deepEqual(yield* target, [Option.some(project.window), Option.some(project.window)]);

      // A request from an unregistered renderer is app-wide too.
      assert.deepEqual(yield* target.pipe(asRequester(devTools)), [
        Option.some(project.window),
        Option.some(project.window),
      ]);

      project.close();
      assert.deepEqual(yield* target, [Option.some(hub.window), Option.some(hub.window)]);
    }).pipe(Effect.provide(ElectronWindowLayer)),
  );
});

describe("activation readiness is per window", () => {
  const brokers: DesktopAppActivationBroker[] = [];
  const registerRenderer = DesktopAppActivationBroker.prototype.registerRenderer;

  beforeEach(() => {
    brokers.length = 0;
    vi.spyOn(DesktopAppActivationBroker.prototype, "registerRenderer").mockImplementation(function (
      this: DesktopAppActivationBroker,
      send,
    ) {
      if (!brokers.includes(this)) brokers.push(this);
      registerRenderer.call(this, send);
    });
  });
  afterEach(() => {
    for (const broker of brokers) broker.close();
    vi.restoreAllMocks();
  });

  const ActivationLayer = DesktopAppActivation.layer.pipe(
    Layer.provideMerge(ElectronWindowLayer),
    Layer.provide(
      Layer.succeed(DesktopWindow.DesktopWindow, {
        activate: Effect.void,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
    Layer.provide(
      Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        stateDir: "/tmp/t3-window-targets-test",
        platform: "linux",
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
    Layer.provide(NodeServices.layer),
  );

  const request = (requestId: string): DesktopAppActivationRequest => ({
    version: 1,
    requestId,
    type: "open-workspace",
    workspaceRoot: "/tmp/project",
    platform: "linux",
  });

  const reportReady = (window: FakeWindow, ready = true) =>
    setReady.handler(ready, { sender: { id: window.webContents.id } });

  const sentRequestIds = (window: FakeWindow) =>
    window.webContents.send.mock.calls
      .filter(([channel]) => channel === DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL)
      .map(([, sent]) => (sent as DesktopAppActivationRequest).requestId);

  it.effect("a request goes to the most recently focused ready window", () =>
    Effect.gen(function* () {
      const { hub, project } = yield* openHubAndProject;
      yield* reportReady(hub);
      yield* reportReady(project);
      hub.focus();

      void brokers[0]!.request(request("request-1"));

      assert.deepEqual(sentRequestIds(hub), ["request-1"]);
      assert.deepEqual(sentRequestIds(project), []);
    }).pipe(Effect.provide(ActivationLayer)),
  );

  it.effect("with the focused window not ready, a request walks focus recency", () =>
    Effect.gen(function* () {
      const { electronWindow, hub, project } = yield* openHubAndProject;
      const other = makeWindow();
      yield* electronWindow.getOrCreate(projectIdentity("project-2"), () =>
        Effect.succeed(other.window),
      );
      yield* reportReady(project);
      yield* reportReady(hub);
      // Focus order, newest first: other (not ready), project, hub.
      hub.focus();
      project.focus();
      other.focus();

      void brokers[0]!.request(request("request-1"));

      assert.deepEqual(sentRequestIds(project), ["request-1"]);
      assert.deepEqual(sentRequestIds(hub), []);
    }).pipe(Effect.provide(ActivationLayer)),
  );

  it.effect("a renderer main did not register cannot clear the app windows", () =>
    Effect.gen(function* () {
      const { hub, project } = yield* openHubAndProject;
      yield* reportReady(hub);
      yield* reportReady(project);
      const devTools = makeWindow();

      yield* reportReady(devTools, false);
      void brokers[0]!.request(request("request-1"));

      assert.deepEqual(sentRequestIds(project), ["request-1"]);
    }).pipe(Effect.provide(ActivationLayer)),
  );

  it.effect("closing one ready window leaves the others activated", () =>
    Effect.gen(function* () {
      const { hub, project } = yield* openHubAndProject;
      yield* reportReady(hub);
      yield* reportReady(project);

      project.close();
      void brokers[0]!.request(request("request-1"));

      assert.deepEqual(sentRequestIds(hub), ["request-1"]);
    }).pipe(Effect.provide(ActivationLayer)),
  );

  it.effect("losing the window handling a request fails only that request", () =>
    Effect.gen(function* () {
      const { hub, project } = yield* openHubAndProject;
      yield* reportReady(hub);
      yield* reportReady(project);
      const broker = brokers[0]!;

      const first = broker.request(request("request-1"));
      const second = broker.request(request("request-2"));
      assert.deepEqual(sentRequestIds(project), ["request-1"]);

      project.close();
      const failed: DesktopAppActivationResponse = yield* Effect.promise(() => first);
      assert.isFalse(failed.ok);
      assert.deepEqual(sentRequestIds(hub), ["request-2"]);

      // A window that reports not ready stops receiving work; the queue waits for another.
      yield* reportReady(hub, false);
      assert.isFalse((yield* Effect.promise(() => second)).ok);
      void broker.request(request("request-3"));
      assert.deepEqual(sentRequestIds(hub), ["request-2"]);
    }).pipe(Effect.provide(ActivationLayer)),
  );
});

describe("a capture reports back to the window it started from", () => {
  it.effect("every event of one capture reaches the window its request pinned", () =>
    Effect.gen(function* () {
      const { electronWindow, hub, project } = yield* openHubAndProject;
      const delivered: Array<readonly [string, Electron.BrowserWindow | null]> = [];
      const dispatch = makePinnedSnapShotDispatch(electronWindow.currentMainOrFirst, (event) =>
        electronWindow.main.pipe(
          Effect.map((window) => void delivered.push([event.type, Option.getOrNull(window)])),
        ),
      );
      const captureId = "0000aaaa-0000-4000-8000-000000000001" as never;

      project.focus();
      assert.isTrue(yield* dispatch({ type: "requested", id: captureId }));
      assert.strictEqual(snapShotCaptureTarget(captureId), project.window);

      // Focus moves before the capture settles; its events stay with the requester.
      hub.focus();
      yield* dispatch({ type: "started", id: captureId });
      yield* dispatch({ type: "ready", id: captureId });

      assert.deepEqual(delivered, [
        ["requested", project.window],
        ["started", project.window],
        ["ready", project.window],
      ]);
      assert.isUndefined(snapShotCaptureTarget(captureId));
      // An event with no capture id is left to the caller's own dispatch.
      assert.isFalse(yield* dispatch({ type: "shortcut-changed" }));
    }).pipe(Effect.provide(ElectronWindowLayer)),
  );

  it.effect("the capture reveals and activates the window it pinned", () =>
    Effect.gen(function* () {
      const { electronWindow, hub, project } = yield* openHubAndProject;
      const dispatch = makePinnedSnapShotDispatch(
        electronWindow.currentMainOrFirst,
        () => Effect.void,
      );
      const revealTarget = withSnapShotRevealTarget(electronWindow.currentMainOrFirst);
      const captureId = "0000aaaa-0000-4000-8000-000000000002" as never;

      project.focus();
      yield* dispatch({ type: "requested", id: captureId });
      hub.focus();
      assert.deepEqual(yield* revealTarget, Option.some(project.window));

      yield* dispatch({ type: "ready", id: captureId });
      assert.deepEqual(yield* revealTarget, Option.some(hub.window));
    }).pipe(Effect.provide(ElectronWindowLayer)),
  );

  it.effect("without an animation, the capture's activation ends its reveal phase", () =>
    Effect.gen(function* () {
      const { electronWindow, hub, project } = yield* openHubAndProject;
      const dispatch = makePinnedSnapShotDispatch(
        electronWindow.currentMainOrFirst,
        () => Effect.void,
      );
      const revealTarget = withSnapShotRevealTarget(electronWindow.currentMainOrFirst);
      // The shape of DesktopWindow.activate's hook: resolve, then end the phase.
      const activateTarget = revealTarget.pipe(Effect.tap(() => endSnapShotReveal));
      const captureId = "0000aaaa-0000-4000-8000-000000000004" as never;

      project.focus();
      yield* dispatch({ type: "requested", id: captureId });
      hub.focus();
      assert.deepEqual(yield* activateTarget, Option.some(project.window));

      // Persisting: the pin still routes the capture's events, but a dock
      // activation goes back to the most recent window.
      assert.strictEqual(snapShotCaptureTarget(captureId), project.window);
      assert.deepEqual(yield* revealTarget, Option.some(hub.window));
      yield* dispatch({ type: "ready", id: captureId });
    }).pipe(Effect.provide(ElectronWindowLayer)),
  );

  it.effect("an interrupted capture releases its pinned window", () =>
    Effect.gen(function* () {
      const { electronWindow, hub, project } = yield* openHubAndProject;
      const dispatch = makePinnedSnapShotDispatch(
        electronWindow.currentMainOrFirst,
        () => Effect.void,
      );
      const revealTarget = withSnapShotRevealTarget(electronWindow.currentMainOrFirst);
      const captureId = "0000aaaa-0000-4000-8000-000000000003" as never;
      const pinnedLatch = yield* Deferred.make<void>();

      project.focus();
      const capture = yield* dispatch({ type: "requested", id: captureId }).pipe(
        Effect.andThen(Deferred.succeed(pinnedLatch, undefined)),
        Effect.andThen(Effect.never),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(pinnedLatch);
      assert.strictEqual(snapShotCaptureTarget(captureId), project.window);

      yield* Fiber.interrupt(capture);
      hub.focus();
      assert.isUndefined(snapShotCaptureTarget(captureId));
      assert.deepEqual(yield* revealTarget, Option.some(hub.window));
    }).pipe(Effect.provide(ElectronWindowLayer)),
  );
});
