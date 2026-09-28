import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Electron from "electron";

import type * as ElectronWindow from "../../electron/ElectronWindow.ts";
import type * as DesktopIpc from "../DesktopIpc.ts";

// Outside an Electron main process this module resolves to a stub, so every
// runtime read is optional even though the types are not.
const runtime = Electron as Partial<typeof Electron>;

/**
 * Resolves the registered app window that sent a snapshot request. Trust follows
 * the window registry, not `getAllWindows`, which also returns windows hosting
 * untrusted web content; anything unregistered is `None`, so callers fail closed.
 * Mirrors `PreviewWindowPolicy.resolvePreviewForSender`.
 */
export const resolveRegisteredSenderWindow = Effect.fn(
  "desktop.ipc.snapShot.resolveRegisteredSenderWindow",
)(function* (
  electronWindow: ElectronWindow.ElectronWindow["Service"],
  event: DesktopIpc.DesktopIpcInvokeEvent,
) {
  const senderWebContents = runtime.webContents?.fromId(event.sender.id) ?? null;
  if (senderWebContents === null) return Option.none<Electron.BrowserWindow>();

  const senderWindow = runtime.BrowserWindow?.fromWebContents(senderWebContents) ?? null;
  if (senderWindow === null) return Option.none<Electron.BrowserWindow>();

  const windowId = yield* electronWindow.windowIdFor(senderWindow);
  return Option.isNone(windowId)
    ? Option.none<Electron.BrowserWindow>()
    : Option.some(senderWindow);
});
