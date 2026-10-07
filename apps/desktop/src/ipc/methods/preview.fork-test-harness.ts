import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BrowserWindow, webContents } from "electron";
import type * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { testWindowId } from "../../window/testWindowIds.fork.ts";

// Fork preview handlers resolve the IPC sender's window before any preview call.
// This registers an upstream case's fake sender as one window, so the case
// reaches its manager unchanged. Requires the caller's `electron` mock.
export const previewSenderWindowFork = (
  manager: Partial<PreviewManager.PreviewManager["Service"]>,
) =>
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          const window = {} as Electron.BrowserWindow;
          const restore = {
            fromId: webContents.fromId,
            fromWebContents: BrowserWindow.fromWebContents,
          };
          webContents.fromId = () => ({}) as Electron.WebContents;
          BrowserWindow.fromWebContents = () => window;
          return restore;
        }),
        (restore) =>
          Effect.sync(() => {
            webContents.fromId = restore.fromId;
            BrowserWindow.fromWebContents = restore.fromWebContents;
          }),
      ),
    ),
    Layer.mock(ElectronWindow.ElectronWindow)({
      windowIdFor: () => Effect.succeedSome(testWindowId(1)),
    }),
    Layer.succeed(PreviewManager.PreviewManager, {
      ...manager,
      forWindow: () => Effect.succeed(manager),
    } as PreviewManager.PreviewManager["Service"]),
  );
