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
import { beforeEach, describe, expect, vi } from "vite-plus/test";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserSession from "../../preview/BrowserSession.ts";
import { previewManagerFixtureLayer } from "../../preview/Manager.fork-test-harness.ts";
import {
  projectWindowIdentity,
  windowIdentityKey,
  HUB_WINDOW_IDENTITY,
} from "../../window/WindowIdentity.ts";
import { projectWindowPreloadArgument } from "../../window/projectWindowArgument.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as PreviewIpc from "./preview.ts";

const { fromWebContents, fromPartition, exposeBridge, invoke } = vi.hoisted(() => ({
  fromWebContents: vi.fn<(_sender: Electron.WebContents) => Electron.BrowserWindow | null>(
    () => null,
  ),
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
  webContents: { fromId: vi.fn(() => null), getFocusedWebContents: vi.fn(() => null) },
}));

describe("fork preview IPC ownership", () => {
  beforeEach(() => {
    fromWebContents.mockReset();
    fromWebContents.mockReturnValue(null);
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
      const hubSender = {} as Electron.WebContents;
      const projectSender = {} as Electron.WebContents;
      const hubWindow = {} as Electron.BrowserWindow;
      const projectWindow = {} as Electron.BrowserWindow;
      let activeSender = hubSender;
      fromWebContents.mockImplementation((sender) =>
        sender === hubSender ? hubWindow : sender === projectSender ? projectWindow : null,
      );
      const windows = {
        identityFor: (window: Electron.BrowserWindow) =>
          Effect.succeed(
            window === hubWindow
              ? Option.some(HUB_WINDOW_IDENTITY)
              : window === projectWindow
                ? Option.some(projectWindowIdentity(projectRef.environmentId, projectRef.projectId))
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
          const hub = await loadBridge(["electron"]);
          const project = await loadBridge(["electron", projectWindowPreloadArgument(projectRef)]);
          expect(hub.projectWindowRef).toBeNull();
          expect(project.projectWindowRef).toEqual(projectRef);
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

          activeSender = {} as Electron.WebContents;
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
    const firstIdentity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    let stateListener: Parameters<
      PreviewManager.PreviewManager["Service"]["subscribeOwnedStateChanges"]
    >[0] = () => Effect.void;

    return Effect.gen(function* () {
      yield* PreviewIpc.installPreviewEventForwarding();
      yield* stateListener(firstIdentity, "tab-1", { tabId: "tab-1" } as never);

      expect(firstSend).toHaveBeenCalledOnce();
      expect(secondSend).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        get: (identity: typeof firstIdentity) =>
          Effect.succeed(
            Option.some({
              webContents: {
                send:
                  windowIdentityKey(identity) === windowIdentityKey(firstIdentity)
                    ? firstSend
                    : secondSend,
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
        subscribeOwnedPointerEvents: () => Effect.void,
      } as never),
    );
  });

  effectIt.effect("resolves the sender identity before invoking its window manager", () => {
    const identity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const sender = {} as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    const closeTab = vi.fn(() => Effect.void);
    fromWebContents.mockReturnValue(senderWindow);

    return PreviewIpc.closeTab.handler({ tabId: "owned-tab" }, { sender }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        identityFor: () => Effect.succeed(Option.some(identity)),
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
    const sender = {} as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    fromWebContents.mockReturnValue(senderWindow);

    return PreviewIpc.closeTab.handler({ tabId: "other-tab" }, { sender }).pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        identityFor: () => Effect.succeed(Option.none()),
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
});
