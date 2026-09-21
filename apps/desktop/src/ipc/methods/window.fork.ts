import { DesktopWindowRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWindow from "../../window/DesktopWindow.ts";
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
