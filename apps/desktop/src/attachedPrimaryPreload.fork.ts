import type { DesktopBridge } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

type AttachedPrimaryBridge = Required<
  Pick<
    DesktopBridge,
    "getAttachedPrimaryBootstrap" | "refreshAttachedPrimaryBootstrap" | "rejectAttachedPrimary"
  >
>;

/** Preload half of the attached primary (RSI-Software/t3code-hyprws#1350). */
export const makeAttachedPrimaryBridge = (ipcRenderer: IpcRenderer): AttachedPrimaryBridge => ({
  getAttachedPrimaryBootstrap: () =>
    ipcRenderer.sendSync(IpcChannels.GET_ATTACHED_PRIMARY_BOOTSTRAP_CHANNEL) ?? null,
  refreshAttachedPrimaryBootstrap: () =>
    ipcRenderer.invoke(IpcChannels.REFRESH_ATTACHED_PRIMARY_BOOTSTRAP_CHANNEL),
  rejectAttachedPrimary: (bearerToken, reason) =>
    ipcRenderer.invoke(IpcChannels.REJECT_ATTACHED_PRIMARY_CHANNEL, { bearerToken, reason }),
});
