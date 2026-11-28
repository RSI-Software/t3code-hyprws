import type { DesktopBridge, WindowScopeSeed } from "@t3tools/contracts";
import { ipcRenderer } from "electron";

import * as IpcChannels from "../ipc/channels.ts";
import { readWindowIdPreloadArgument } from "../window/WindowId.fork.ts";
import { readWindowScopeSeedPreloadArgument } from "../window/WindowScopeSeed.fork.ts";

export type PreviewCapableDesktopBridge = DesktopBridge & {
  readonly preview: NonNullable<DesktopBridge["preview"]>;
};

/**
 * The fork's desktop-window bridge members. They are optional in the contract,
 * so the upstream bridge literal stays as upstream wrote it and this is the
 * only place the fork adds to it.
 */
export type ProjectWindowCapabilities = Required<
  Pick<DesktopBridge, "requestWindow" | "publishWindowProjects">
> &
  Pick<DesktopBridge, "windowId" | "windowScopeSeed">;

const windowIdCapability = (): Pick<DesktopBridge, "windowId"> => {
  const windowId = readWindowIdPreloadArgument(process.argv);
  return windowId === null ? {} : { windowId };
};

const projectWindowCapabilities = (): ProjectWindowCapabilities => ({
  requestWindow: (request) => ipcRenderer.invoke(IpcChannels.REQUEST_WINDOW_CHANNEL, request),
  publishWindowProjects: (projects) =>
    ipcRenderer.invoke(IpcChannels.PUBLISH_WINDOW_PROJECTS_CHANNEL, projects),
  // Main passes every app window its id; a window main did not create has none.
  ...windowIdCapability(),
  // Branded ids are plain strings at runtime; the preload cannot import the
  // contracts package without breaking its sandboxed bundle.
  windowScopeSeed: readWindowScopeSeedPreloadArgument(process.argv) as WindowScopeSeed | null,
});

/** Keep the fork policy at one seam without rebuilding the upstream bridge. */
export function exposePreviewCapability<Bridge extends PreviewCapableDesktopBridge>(
  bridge: Bridge,
): Bridge & ProjectWindowCapabilities {
  return { ...bridge, ...projectWindowCapabilities() };
}
