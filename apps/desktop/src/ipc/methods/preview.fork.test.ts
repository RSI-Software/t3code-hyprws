import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  type DesktopBridge,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, vi } from "vite-plus/test";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserSession from "../../preview/BrowserSession.ts";
import { projectWindowIdentity } from "../../window/WindowIdentity.ts";
import { forkSupersedes } from "../../../../../scripts/lib/fork-supersedes.ts";
import { previewManagerFixtureLayer } from "../../preview/Manager.fork-test-harness.ts";
import { type WindowId, windowIdPreloadArgument } from "../../window/WindowId.fork.ts";
import { projectWindowPreloadArgument } from "../../window/projectWindowArgument.ts";

const hubWindowId = "00000000-0000-4000-8000-000000000001" as WindowId;
const projectWindowId = "00000000-0000-4000-8000-000000000002" as WindowId;
import * as DesktopIpc from "../DesktopIpc.ts";
import * as PreviewIpc from "./preview.ts";

const { fromWebContents, fromId, fromPartition, exposeBridge, invoke } = vi.hoisted(() => ({
  fromWebContents: vi.fn<(_sender: Electron.WebContents) => Electron.BrowserWindow | null>(
    () => null,
  ),
  fromId: vi.fn<(_id: number) => Electron.WebContents | null>(() => null),
  fromPartition: vi.fn(),
  exposeBridge: vi.fn<(_name: string, _bridge: DesktopBridge) => void>(),
  invoke: vi.fn<(_channel: string, _payload?: unknown) => Promise<unknown>>(),
}));
vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents, getAllWindows: vi.fn(() => []) },
  contextBridge: { exposeInMainWorld: exposeBridge },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn(), sendSync: vi.fn() },
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  session: { fromPartition },
  webContents: { fromId, getFocusedWebContents: vi.fn(() => null) },
}));

describe("fork preview IPC ownership", () => {
  beforeEach(() => {
    fromWebContents.mockReset();
    fromWebContents.mockReturnValue(null);
    fromId.mockReset();
    fromId.mockReturnValue(null);
    fromPartition.mockReset();
    exposeBridge.mockReset();
    invoke.mockReset();
  });

  effectIt.effect(
    "preserves profile partitions and window ownership through the assembled preload",
    () => {
      const stored = new Map<string, { cookies: Set<string>; cache: Set<string> }>();
      fromPartition.mockImplementation((partition: string) => {
        const state = { cookies: new Set(["session"]), cache: new Set(["page"]) };
        stored.set(partition, state);
        return {
          getUserAgent: () => "Mozilla/5.0 Electron/41.5.0 t3code/0.0.39",
          setUserAgent: vi.fn(),
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          clearStorageData: async () => {
            state.cookies.clear();
          },
          clearCache: async () => {
            state.cache.clear();
          },
        };
      });
      const projectRef = {
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
      };
      const hubSender = { id: 1 } as Electron.WebContents;
      const projectSender = { id: 2 } as Electron.WebContents;
      const hubWindow = {} as Electron.BrowserWindow;
      const projectWindow = {} as Electron.BrowserWindow;
      let activeSender = hubSender;
      fromId.mockImplementation((id) =>
        id === hubSender.id ? hubSender : id === projectSender.id ? projectSender : null,
      );
      fromWebContents.mockImplementation((sender) =>
        sender === hubSender ? hubWindow : sender === projectSender ? projectWindow : null,
      );
      const windows = {
        windowIdFor: (window: Electron.BrowserWindow) =>
          Effect.succeed(
            window === hubWindow
              ? Option.some(hubWindowId)
              : window === projectWindow
                ? Option.some(projectWindowId)
                : Option.none(),
          ),
      } as ElectronWindow.ElectronWindow["Service"];
      const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
      const ipc = DesktopIpc.make({
        removeHandler: (channel) => {
          handlers.delete(channel);
        },
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
        removeAllListeners: () => {},
        on: () => {},
      });
      invoke.mockImplementation((channel, payload) => {
        const handler = handlers.get(channel);
        if (handler === undefined)
          return Promise.reject(new Error(`unregistered fixture channel: ${channel}`));
        return Promise.resolve(handler({ sender: activeSender }, payload));
      });
      const loadBridge = async (argv: string[]) => {
        const original = process.argv;
        process.argv = argv;
        try {
          vi.resetModules();
          await import("../../preload.ts");
          const exposed = exposeBridge.mock.calls.at(-1);
          expect(exposed?.[0]).toBe("desktopBridge");
          if (exposed === undefined) throw new Error("preload did not expose its bridge");
          return exposed[1];
        } finally {
          process.argv = original;
        }
      };
      const managerLayer = previewManagerFixtureLayer(
        BrowserSession.layer.pipe(Layer.provide(NodeServices.layer)),
      );
      return Effect.gen(function* () {
        for (const method of [
          PreviewIpc.createTab,
          PreviewIpc.closeTab,
          PreviewIpc.navigate,
          PreviewIpc.automationStatus,
          PreviewIpc.clearCookies,
          PreviewIpc.clearCache,
          PreviewIpc.getPreviewConfig,
        ]) {
          yield* ipc.handle(method);
        }
        yield* Effect.promise(async () => {
          const hubArgv = ["electron", windowIdPreloadArgument(hubWindowId)];
          const hub = await loadBridge(hubArgv);
          const project = await loadBridge([
            "electron",
            windowIdPreloadArgument(projectWindowId),
            projectWindowPreloadArgument(projectRef),
          ]);
          expect(hub.projectWindowRef).toBeNull();
          expect(project.projectWindowRef).toEqual(projectRef);
          expect(hub.windowId).toBe(hubWindowId);
          expect(project.windowId).toBe(projectWindowId);
          // A reload runs the preload again over the arguments main gave the
          // window at creation, so the renderer reads the same id back.
          expect((await loadBridge(hubArgv)).windowId).toBe(hubWindowId);
          const hubPreview = hub.preview!;
          const projectPreview = project.preview!;
          expect(hubPreview).toBeDefined();
          expect(projectPreview).toBeDefined();

          activeSender = hubSender;
          const work = await hubPreview.getPreviewConfig(projectRef.environmentId, "work");
          const personal = await hubPreview.getPreviewConfig(projectRef.environmentId, "personal");
          const defaultProfile = await hubPreview.getPreviewConfig(
            projectRef.environmentId,
            DEFAULT_BROWSER_PROFILE_ID,
          );
          const incognito = await hubPreview.getPreviewConfig(
            projectRef.environmentId,
            INCOGNITO_BROWSER_PROFILE_ID,
          );
          expect(
            new Set([
              work.partition,
              personal.partition,
              defaultProfile.partition,
              incognito.partition,
            ]).size,
          ).toBe(4);
          expect(work.partition).toMatch(/^persist:t3code-preview-profile-/);
          expect(defaultProfile.partition).toMatch(/^persist:t3code-preview-/);
          expect(incognito.partition).toMatch(/^t3code-preview-ephemeral-profile-/);
          activeSender = projectSender;
          expect(
            (await projectPreview.getPreviewConfig(projectRef.environmentId, "work")).partition,
          ).toBe(work.partition);
          await projectPreview.clearCookies(projectRef.environmentId, "work");
          expect(stored.get(work.partition)?.cookies.size).toBe(0);
          expect(stored.get(personal.partition)?.cookies.size).toBe(1);
          expect(stored.get(defaultProfile.partition)?.cookies.size).toBe(1);
          expect(stored.get(incognito.partition)?.cookies.size).toBe(1);
          activeSender = hubSender;
          await hubPreview.clearCache(projectRef.environmentId, "personal");
          expect(stored.get(personal.partition)?.cache.size).toBe(0);
          expect(stored.get(work.partition)?.cache.size).toBe(1);

          await hubPreview.createTab("shared");
          await hubPreview.navigate("shared", "https://hub.example/");
          await hubPreview.createTab("hub-only");
          activeSender = projectSender;
          await projectPreview.createTab("shared");
          await projectPreview.navigate("shared", "https://project.example/");
          expect(await projectPreview.automation.status("shared")).toMatchObject({
            url: "https://project.example/",
          });
          await expect(projectPreview.closeTab("hub-only")).rejects.toThrow(
            "owned by another window",
          );
          await projectPreview.closeTab("shared");
          activeSender = hubSender;
          expect(await hubPreview.automation.status("shared")).toMatchObject({
            url: "https://hub.example/",
          });

          activeSender = { id: 3 } as Electron.WebContents;
          await expect(
            projectPreview.clearCookies(projectRef.environmentId, "personal"),
          ).rejects.toThrow("not an authorized desktop window");
          await expect(
            projectPreview.getPreviewConfig(projectRef.environmentId, "unregistered"),
          ).rejects.toThrow("not an authorized desktop window");
          expect(stored.size).toBe(4);
          expect(stored.get(personal.partition)?.cookies.size).toBe(1);
        });
      }).pipe(
        Effect.provideService(ElectronWindow.ElectronWindow, windows),
        Effect.provide(managerLayer),
        Effect.scoped,
      );
    },
  );

  effectIt.effect("routes preview events only to their owning window", () => {
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    let stateListener: Parameters<
      PreviewManager.PreviewManager["Service"]["subscribeOwnedStateChanges"]
    >[0] = () => Effect.void;

    return Effect.gen(function* () {
      yield* PreviewIpc.installPreviewEventForwarding();
      yield* stateListener(projectWindowId, "tab-1", { tabId: "tab-1" } as never);

      expect(firstSend).toHaveBeenCalledOnce();
      expect(secondSend).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        getById: (windowId: WindowId) =>
          Effect.succeed(
            Option.some({
              webContents: {
                send: windowId === projectWindowId ? firstSend : secondSend,
              },
            } as never),
          ),
      } as never),
      Effect.provideService(PreviewManager.PreviewManager, {
        subscribeOwnedStateChanges: (listener: typeof stateListener) =>
          Effect.sync(() => {
            stateListener = listener;
          }),
        subscribeOwnedRecordingFrames: () => Effect.void,
        subscribeOwnedRecordingInputs: () => Effect.void,
        subscribeOwnedPointerEvents: () => Effect.void,
      } as never),
    );
  });

  effectIt.effect("starts recording on the sender's window manager, not the hub", () => {
    const sender = { id: 1 } as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    const projectStartRecording = vi.fn(() => Effect.void);
    const hubStartRecording = vi.fn(() => Effect.void);
    fromId.mockReturnValue(sender);
    fromWebContents.mockReturnValue(senderWindow);

    return PreviewIpc.startRecording.handler({ tabId: "owned-tab" }, { sender }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        windowIdFor: () => Effect.succeed(Option.some(projectWindowId)),
      } as never),
      Effect.provideService(DesktopClientSettings.DesktopClientSettings, {
        get: Effect.succeed(
          Option.some({
            browserRecordingShowKeyPresses: true,
            browserRecordingShowMousePresses: false,
          }),
        ),
      } as never),
      Effect.provideService(PreviewManager.PreviewManager, {
        forWindow: (requested: WindowId) =>
          Effect.succeed({
            startRecording:
              requested === projectWindowId ? projectStartRecording : hubStartRecording,
          } as never),
      } as never),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(projectStartRecording).toHaveBeenCalledWith("owned-tab", {
            showKeyPresses: true,
            showMousePresses: false,
          });
          expect(hubStartRecording).not.toHaveBeenCalled();
        }),
      ),
    );
  });

  effectIt.effect("resolves the sender window before invoking its window manager", () => {
    const sender = { id: 1 } as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    const closeTab = vi.fn(() => Effect.void);
    fromId.mockReturnValue(sender);
    fromWebContents.mockReturnValue(senderWindow);

    return PreviewIpc.closeTab.handler({ tabId: "owned-tab" }, { sender }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        windowIdFor: () => Effect.succeed(Option.some(projectWindowId)),
      } as never),
      Effect.provideService(PreviewManager.PreviewManager, {
        forWindow: () => Effect.succeed({ closeTab } as never),
      } as never),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(closeTab).toHaveBeenCalledWith("owned-tab");
        }),
      ),
    );
  });

  effectIt.effect("rejects an unregistered sender before resolving preview state", () => {
    const sender = { id: 1 } as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    fromId.mockReturnValue(sender);
    fromWebContents.mockReturnValue(senderWindow);

    return PreviewIpc.closeTab.handler({ tabId: "other-tab" }, { sender }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        windowIdFor: () => Effect.succeed(Option.none()),
      } as never),
      Effect.provideService(PreviewManager.PreviewManager, null as never),
      Effect.exit,
      Effect.map((exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "PreviewIpcSenderNotAuthorizedError",
          reason: "unregistered-window",
        });
      }),
    );
  });

  // Fork handlers resolve the sender's window before any preview state (commit `70240ecf8e5`).
  forkSupersedes({
    upstream:
      "apps/desktop/src/ipc/methods/preview.test.ts > rejects invalid webContents ids before resolving the preview service",
    reason:
      "fork preview handlers resolve the sender window first, so they require the ElectronWindow service the upstream case never provides",
    commit: "70240ecf8e5",
  });
  effectIt.effect("rejects invalid webContents ids before resolving the sender window", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(
          Effect.provideService(ElectronWindow.ElectronWindow, null as never),
          Effect.provideService(PreviewManager.PreviewManager, null as never),
          Effect.exit,
        ),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  // Fork automation status reads the sender window's own preview manager (commit `70240ecf8e5`).
  forkSupersedes({
    upstream:
      "apps/desktop/src/ipc/methods/preview.test.ts > returns automation status for long runtime tab ids",
    reason:
      "fork automation status resolves the sender window's preview manager, so it needs a sender and the ElectronWindow service the upstream case never provides",
    commit: "70240ecf8e5",
  });
  effectIt.effect("returns automation status for long tab ids from the sender's window", () => {
    const identity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const sender = { id: 7 } as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    fromId.mockReturnValue(sender);
    fromWebContents.mockReturnValue(senderWindow);

    return Effect.gen(function* () {
      const tabId =
        `["environment-1","thread:delegated-task:${"a".repeat(120)}",` +
        `"server-epoch-1","preview-1"]`;
      const status = {
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      };

      const owners: unknown[] = [];
      const recordOwner = (owner: unknown) => Effect.sync(() => owners.push(owner));
      const automation = Effect.succeed({
        automationStatus: () => Effect.succeed(status),
      } as never);

      expect(tabId.length).toBeGreaterThan(128);
      expect(
        yield* PreviewIpc.automationStatus.handler({ tabId }, { sender }).pipe(
          Effect.provideService(ElectronWindow.ElectronWindow, {
            windowIdFor: () => Effect.succeed(Option.some(hubWindowId)),
          } as never),
          Effect.provideService(PreviewManager.PreviewManager, {
            forWindow: (owner: unknown) => Effect.andThen(recordOwner(owner), automation),
          } as never),
        ),
      ).toEqual(status);
      expect(owners).toEqual([hubWindowId]);
      expect(owners).not.toContainEqual(identity);
    });
  });
});
