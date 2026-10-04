import { DesktopWindowProjects, DesktopWindowRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { IpcRequester } from "../../electron/WindowTargets.fork.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { HyprlandPlacement } from "../../window/HyprlandPlacement.ts";
import { isWindowId } from "../../window/WindowId.fork.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Every client window request goes through the one window dispatch table. */
export const requestWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REQUEST_WINDOW_CHANNEL,
  payload: DesktopWindowRequest,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.requestWindow")(function* (request) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.requestWindow(request);
  }),
});

/**
 * A window reporting the projects its filter shows. Only the window itself may
 * report for its id: a sender whose webContents is not that window's is ignored.
 */
export const publishWindowProjects = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PUBLISH_WINDOW_PROJECTS_CHANNEL,
  payload: DesktopWindowProjects,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.publishWindowProjects")(function* ({ windowId, scope }) {
    if (!isWindowId(windowId)) return;
    const requester = yield* IpcRequester;
    const window = yield* (yield* ElectronWindow).getById(windowId);
    if (
      Option.isNone(requester) ||
      Option.isNone(window) ||
      window.value.webContents.id !== requester.value
    ) {
      return;
    }
    yield* (yield* HyprlandPlacement).publishScope(windowId, scope);
  }),
});
