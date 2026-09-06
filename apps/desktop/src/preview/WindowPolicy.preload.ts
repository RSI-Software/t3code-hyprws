import type { DesktopBridge, ScopedProjectRef } from "@t3tools/contracts";
import { ipcRenderer } from "electron";

import * as IpcChannels from "../ipc/channels.ts";
import { readProjectWindowPreloadParts } from "../window/projectWindowArgument.ts";

export type PreviewCapableDesktopBridge = DesktopBridge & {
  readonly preview: NonNullable<DesktopBridge["preview"]>;
};

/**
 * The bridge members a project window needs on top of the upstream bridge:
 * which project the window renders, whether the hub still demands it, and how
 * to open another one. They are optional in the contract, so the upstream
 * bridge literal stays exactly as upstream wrote it and this is the only place
 * the fork adds to it.
 */
export type ProjectWindowCapabilities = Required<
  Pick<
    DesktopBridge,
    "openProjectWindow" | "projectWindowRef" | "getWindowDemandState" | "onWindowDemandStateChange"
  >
>;

let windowDemandState = true;
const windowDemandStateListeners = new Set<(demanded: boolean) => void>();

/**
 * One preload process serves one renderer, so the hub demand channel is
 * subscribed once at module load. Registering inside `exposePreviewCapability`
 * would add a second `ipcRenderer` listener on every extra call.
 */
ipcRenderer.on(IpcChannels.WINDOW_DEMAND_STATE_CHANNEL, (_event, demanded: unknown) => {
  if (typeof demanded !== "boolean" || demanded === windowDemandState) return;
  windowDemandState = demanded;
  for (const listener of windowDemandStateListeners) listener(demanded);
});

const projectWindowCapabilities = (): ProjectWindowCapabilities => ({
  openProjectWindow: (projectRef) =>
    ipcRenderer.invoke(IpcChannels.OPEN_PROJECT_WINDOW_CHANNEL, projectRef),
  // Branded ids are plain strings at runtime; the preload cannot import the
  // contracts package without breaking its sandboxed bundle.
  projectWindowRef: readProjectWindowPreloadParts(process.argv) as ScopedProjectRef | null,
  getWindowDemandState: () => windowDemandState,
  onWindowDemandStateChange: (listener) => {
    windowDemandStateListeners.add(listener);
    return () => windowDemandStateListeners.delete(listener);
  },
});

/** Keep the fork policy at one seam without rebuilding the upstream bridge. */
export function exposePreviewCapability<Bridge extends PreviewCapableDesktopBridge>(
  bridge: Bridge,
): Bridge & ProjectWindowCapabilities {
  return { ...bridge, ...projectWindowCapabilities() };
}
