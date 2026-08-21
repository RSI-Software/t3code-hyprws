import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewWindowPolicy from "../../preview/WindowPolicy.ts";
import * as IpcChannels from "../channels.ts";
import type * as DesktopIpc from "../DesktopIpc.ts";
import type * as PreviewIpc from "./preview.ts";

export class PreviewIpcSenderNotAuthorizedError extends Schema.TaggedError<PreviewIpcSenderNotAuthorizedError>()(
  "PreviewIpcSenderNotAuthorizedError",
  { reason: Schema.Literals(["missing-sender", "unregistered-window"]) },
) {
  override get message(): string {
    return "Preview IPC sender is not an authorized desktop window.";
  }
}

const senderPreviewManager = Effect.fn("desktop.ipc.preview.resolveSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const previewManager = yield* PreviewManager.PreviewManager;
  const { windowManager } = yield* PreviewWindowPolicy.resolvePreviewForSender(
    event,
    yield* ElectronWindow.ElectronWindow,
    previewManager,
    (reason) => new PreviewIpcSenderNotAuthorizedError({ reason }),
  );
  return PreviewManager.PreviewManager.of({ ...previewManager, ...windowManager });
});

/**
 * Upstream handlers read the app-wide `PreviewManager`; each one instead sees its sender
 * window's operations, so a window can only reach the tabs it owns. The static types still
 * name upstream's requirements: the sender lookup adds `ElectronWindow` and its
 * authorization failure, both present wherever the preview handlers are installed.
 */
type PreviewMethodEffect = ReturnType<(typeof PreviewIpc.methods)[number]["handler"]>;

export const scopeMethodsToSender = (methods: typeof PreviewIpc.methods) => {
  for (const method of methods) {
    const handler: (
      raw: unknown,
      event?: DesktopIpc.DesktopIpcInvokeEvent,
    ) => Effect.Effect<
      unknown,
      Effect.Error<PreviewMethodEffect>,
      Effect.Services<PreviewMethodEffect>
    > = method.handler;
    Object.assign(method, {
      handler: (raw: unknown, event?: DesktopIpc.DesktopIpcInvokeEvent) =>
        Effect.provideServiceEffect(
          handler(raw, event),
          PreviewManager.PreviewManager,
          senderPreviewManager(event),
        ),
    });
  }
};

/**
 * Routes each preview event to the window that owns its tab. Upstream broadcasts to every
 * window, which would leak one window's tabs into the others, so success skips it.
 */
export const installOwnedEventForwarding = Effect.fn(
  "desktop.ipc.preview.installOwnedEventForwarding",
)(function* () {
  yield* PreviewWindowPolicy.installEventForwarding(
    yield* ElectronWindow.ElectronWindow,
    yield* PreviewManager.PreviewManager,
    {
      stateChange: IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL,
      recordingFrame: IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL,
      recordingInput: IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL,
      pointerEvent: IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL,
      openLink: IpcChannels.PREVIEW_OPEN_LINK_CHANNEL,
    },
  );
  return true;
});
