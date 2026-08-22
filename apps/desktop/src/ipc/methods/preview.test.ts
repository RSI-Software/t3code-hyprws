import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { projectWindowIdentity, windowIdentityKey } from "../../window/WindowIdentity.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition, fromWebContents } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
  fromWebContents: vi.fn(() => null as Electron.BrowserWindow | null),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents,
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
    fromWebContents.mockReset();
    fromWebContents.mockReturnValue(null);
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

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

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(
          Effect.provideService(PreviewManager.PreviewManager, null as never),
          Effect.provideService(ElectronWindow.ElectronWindow, null as never),
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
});
