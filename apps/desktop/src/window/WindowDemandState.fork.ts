import type * as Electron from "electron";

import { WINDOW_DEMAND_STATE_CHANNEL } from "../ipc/channels.ts";

/**
 * Tells the renderer whether its window is on screen, so hidden managed zmux
 * terminals can suspend. Returns the publisher for a renderer that just loaded.
 */
export const bindWindowDemandStateFork = (window: Electron.BrowserWindow): (() => void) => {
  const publish = () => {
    if (window.isDestroyed()) return;
    window.webContents.send(
      WINDOW_DEMAND_STATE_CHANNEL,
      window.isVisible() && !window.isMinimized(),
    );
  };
  // Electron show/hide and minimize/restore are the explicit desktop
  // visibility boundary. Focus is intentionally excluded: another visible
  // window receiving focus does not hide this retained surface.
  window.on("show", publish);
  window.on("hide", publish);
  window.on("minimize", publish);
  window.on("restore", publish);
  return publish;
};
