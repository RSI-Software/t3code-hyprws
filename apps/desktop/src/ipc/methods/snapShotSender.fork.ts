import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Electron from "electron";

import type * as ElectronWindow from "../../electron/ElectronWindow.ts";
import type * as DesktopIpc from "../DesktopIpc.ts";

// Outside an Electron main process this module resolves to a stub, so every
// runtime read is optional even though the types are not.
const runtime = Electron as Partial<typeof Electron>;

/**
 * Resolves the registered app window that sent a snapshot IPC request.
 *
 * The hub is not the only trusted renderer: a project window is its own
 * `BrowserWindow` with its own `webContents`, so its snapshot requests are
 * legitimate. Trust follows the window registry rather than `getAllWindows`,
 * which would also return the preview and browser windows that host untrusted
 * web content. Resolution mirrors `PreviewWindowPolicy.resolvePreviewForSender`.
 *
 * Anything the registry cannot name resolves to `None`, so callers fail closed.
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

  const identity = yield* electronWindow.identityFor(senderWindow);
  return Option.isNone(identity)
    ? Option.none<Electron.BrowserWindow>()
    : Option.some(senderWindow);
});
