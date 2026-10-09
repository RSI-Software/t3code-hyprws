import { VoiceDuckingOutputsFork, VoiceDuckingStartFork } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import {
  DesktopVoiceDuckingFork,
  VoiceDuckingErrorFork,
} from "../../voice-input/DesktopVoiceDucking.fork.ts";
import * as Channels from "../../voice-input/channels.fork.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { resolveRegisteredSenderWindow } from "./snapShotSender.fork.ts";

const owner = Effect.fn(function* (event?: DesktopIpc.DesktopIpcInvokeEvent) {
  const windows = yield* ElectronWindow;
  if (!event || Option.isNone(yield* resolveRegisteredSenderWindow(windows, event))) {
    return yield* new VoiceDuckingErrorFork({
      message: "Speaker volume requires a registered desktop window.",
    });
  }
  return event.sender.id;
});

export const listOutputs = DesktopIpc.makeIpcMethod({
  channel: Channels.VOICE_DUCKING_OUTPUTS_FORK,
  payload: Schema.Void,
  result: VoiceDuckingOutputsFork,
  handler: Effect.fn(function* (_input, event) {
    yield* owner(event);
    return yield* (yield* DesktopVoiceDuckingFork).list;
  }),
});
export const start = DesktopIpc.makeIpcMethod({
  channel: Channels.VOICE_DUCKING_START_FORK,
  payload: VoiceDuckingStartFork,
  result: Schema.Void,
  handler: Effect.fn(function* ({ sessionId, settings }, event) {
    const sender = yield* owner(event);
    yield* (yield* DesktopVoiceDuckingFork).start(sender, sessionId, settings);
  }),
});
export const stop = DesktopIpc.makeIpcMethod({
  channel: Channels.VOICE_DUCKING_STOP_FORK,
  payload: Schema.Struct({ sessionId: VoiceDuckingStartFork.fields.sessionId }),
  result: Schema.Void,
  handler: Effect.fn(function* ({ sessionId }, event) {
    const sender = yield* owner(event);
    yield* (yield* DesktopVoiceDuckingFork).stop(sender, sessionId);
  }),
});
