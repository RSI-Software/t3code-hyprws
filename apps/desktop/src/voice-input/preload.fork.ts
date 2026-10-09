import type { VoiceDuckingBridgeFork } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";
import * as Channels from "./channels.fork.ts";

export const makeVoiceDuckingBridgeFork = (ipc: IpcRenderer): VoiceDuckingBridgeFork => ({
  listOutputs: () => ipc.invoke(Channels.VOICE_DUCKING_OUTPUTS_FORK),
  start: (sessionId, settings) =>
    ipc.invoke(Channels.VOICE_DUCKING_START_FORK, { sessionId, settings }),
  stop: (sessionId) => ipc.invoke(Channels.VOICE_DUCKING_STOP_FORK, { sessionId }),
});
