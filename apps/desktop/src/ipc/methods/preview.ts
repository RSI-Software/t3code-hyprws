import {
  DesktopPreviewAnnotationThemeInputSchema,
  DesktopPreviewArtifactInputSchema,
  DesktopPreviewAutomationClickInputSchema,
  DesktopPreviewAutomationEvaluateInputSchema,
  DesktopPreviewAutomationPressInputSchema,
  DesktopPreviewAutomationScrollInputSchema,
  DesktopPreviewAutomationStatusSchema,
  DesktopPreviewAutomationTypeInputSchema,
  DesktopPreviewAutomationWaitForInputSchema,
  DesktopPreviewConfigInputSchema,
  DesktopPreviewNavigateInputSchema,
  DesktopPreviewRecordingArtifactSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewRegisterWebviewInputSchema,
  DesktopPreviewScreenshotArtifactSchema,
  DesktopPreviewSetAudioMutedInputSchema,
  DesktopPreviewSetColorSchemeInputSchema,
  DesktopPreviewCreateTabInputSchema,
  DesktopPreviewTabInputSchema,
  DesktopPreviewWebviewConfigSchema,
  PreviewAnnotationSubmissionResultSchema,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";
import { BrowserWindow } from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview/WebviewPreferences.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export class PreviewIpcSenderNotAuthorizedError extends Schema.TaggedErrorClass<PreviewIpcSenderNotAuthorizedError>()(
  "PreviewIpcSenderNotAuthorizedError",
  { reason: Schema.Literals(["missing-sender", "unregistered-window"]) },
) {
  override get message(): string {
    return "Preview IPC sender is not an authorized desktop window.";
  }
}

const previewForSender = Effect.fn("desktop.ipc.preview.resolveSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  if (!event?.sender) {
    return yield* new PreviewIpcSenderNotAuthorizedError({ reason: "missing-sender" });
  }
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const identity =
    senderWindow === null ? Option.none() : yield* electronWindow.identityFor(senderWindow);
  if (Option.isNone(identity)) {
    return yield* new PreviewIpcSenderNotAuthorizedError({ reason: "unregistered-window" });
  }
  const previewManager = yield* PreviewManager.PreviewManager;
  const windowManager = yield* previewManager.forWindow(identity.value);
  return { identity: identity.value, previewManager, windowManager };
});

export const installPreviewEventForwarding = Effect.fn(
  "desktop.ipc.preview.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const manager = yield* PreviewManager.PreviewManager;
  const send = (
    identity: Parameters<typeof electronWindow.get>[0],
    channel: string,
    ...args: readonly unknown[]
  ) =>
    electronWindow.get(identity).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (window) => Effect.sync(() => window.webContents.send(channel, ...args)),
        }),
      ),
    );
  yield* manager.subscribeOwnedStateChanges((identity, tabId, state) =>
    send(identity, IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state),
  );
  yield* manager.subscribeOwnedRecordingFrames((identity, frame) =>
    send(identity, IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, frame),
  );
  yield* manager.subscribeOwnedPointerEvents((identity, event) =>
    send(identity, IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, event),
  );
});

export const createTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREATE_TAB_CHANNEL,
  payload: DesktopPreviewCreateTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.createTab")(function* (
    { tabId, zoomFactor, colorScheme },
    event,
  ) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.createTab(tabId, { zoomFactor, colorScheme });
  }),
});

export const closeTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.closeTab")(function* ({ tabId }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.closeTab(tabId);
  }),
});

export const registerWebview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL,
  payload: DesktopPreviewRegisterWebviewInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.registerWebview")(function* (
    { tabId, webContentsId },
    event,
  ) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.registerWebview(tabId, webContentsId);
  }),
});

export const navigate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_NAVIGATE_CHANNEL,
  payload: DesktopPreviewNavigateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.navigate")(function* ({ tabId, url }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.navigate(tabId, url);
  }),
});

const tabMethod = (
  channel: string,
  name: string,
  invoke: (
    manager: PreviewManager.PreviewWindowManager,
    tabId: string,
  ) => Effect.Effect<void, PreviewManager.PreviewManagerError>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopPreviewTabInputSchema,
    result: Schema.Void,
    handler: Effect.fn(name)(function* ({ tabId }, event) {
      const { windowManager: manager } = yield* previewForSender(event);
      yield* invoke(manager, tabId);
    }),
  });

export const goBack = tabMethod(
  IpcChannels.PREVIEW_GO_BACK_CHANNEL,
  "desktop.ipc.preview.goBack",
  (manager, tabId) => manager.goBack(tabId),
);
export const goForward = tabMethod(
  IpcChannels.PREVIEW_GO_FORWARD_CHANNEL,
  "desktop.ipc.preview.goForward",
  (manager, tabId) => manager.goForward(tabId),
);
export const refresh = tabMethod(
  IpcChannels.PREVIEW_REFRESH_CHANNEL,
  "desktop.ipc.preview.refresh",
  (manager, tabId) => manager.refresh(tabId),
);
export const zoomIn = tabMethod(
  IpcChannels.PREVIEW_ZOOM_IN_CHANNEL,
  "desktop.ipc.preview.zoomIn",
  (manager, tabId) => manager.zoomIn(tabId),
);
export const zoomOut = tabMethod(
  IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL,
  "desktop.ipc.preview.zoomOut",
  (manager, tabId) => manager.zoomOut(tabId),
);
export const resetZoom = tabMethod(
  IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL,
  "desktop.ipc.preview.resetZoom",
  (manager, tabId) => manager.resetZoom(tabId),
);
export const hardReload = tabMethod(
  IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL,
  "desktop.ipc.preview.hardReload",
  (manager, tabId) => manager.hardReload(tabId),
);
export const setColorScheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL,
  payload: DesktopPreviewSetColorSchemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setColorScheme")(function* (
    { tabId, colorScheme },
    event,
  ) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.setColorScheme(tabId, colorScheme);
  }),
});
export const setAudioMuted = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL,
  payload: DesktopPreviewSetAudioMutedInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAudioMuted")(function* ({ tabId, audioMuted }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.setAudioMuted(tabId, audioMuted);
  }),
});
export const openDevTools = tabMethod(
  IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
  "desktop.ipc.preview.openDevTools",
  (manager, tabId) => manager.openDevTools(tabId),
);
export const cancelPickElement = tabMethod(
  IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL,
  "desktop.ipc.preview.cancelPickElement",
  (manager, tabId) => manager.cancelPickElement(tabId),
);
export const startRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_START_CHANNEL,
  "desktop.ipc.preview.startRecording",
  (manager, tabId) => manager.startRecording(tabId),
);
export const stopRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL,
  "desktop.ipc.preview.stopRecording",
  (manager, tabId) => manager.stopRecording(tabId),
);
export const openPictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL,
  "desktop.ipc.preview.openPictureInPicture",
  (manager, tabId) => manager.openPictureInPicture(tabId),
);
export const closePictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL,
  "desktop.ipc.preview.closePictureInPicture",
  (manager, tabId) => manager.closePictureInPicture(tabId),
);

export const clearCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCookies")(function* (_input, event) {
    const { previewManager: manager } = yield* previewForSender(event);
    yield* manager.clearCookies();
  }),
});

export const clearCache = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCache")(function* (_input, event) {
    const { previewManager: manager } = yield* previewForSender(event);
    yield* manager.clearCache();
  }),
});

export const getPreviewConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_CONFIG_CHANNEL,
  payload: DesktopPreviewConfigInputSchema,
  result: DesktopPreviewWebviewConfigSchema,
  handler: Effect.fn("desktop.ipc.preview.getConfig")(function* ({ environmentId }, event) {
    const { previewManager: manager } = yield* previewForSender(event);
    yield* manager.getBrowserSession(environmentId);
    return {
      partition: yield* manager.getBrowserPartition(environmentId),
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: NodeURL.pathToFileURL(`${__dirname}/preview-pick-preload.cjs`).href,
    };
  }),
});

export const setAnnotationTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
  payload: DesktopPreviewAnnotationThemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationTheme")(function* ({ theme }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.setAnnotationTheme(theme);
  }),
});

export const pickElement = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(PreviewAnnotationSubmissionResultSchema),
  handler: Effect.fn("desktop.ipc.preview.pickElement")(function* ({ tabId }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    return yield* manager.pickElement(tabId);
  }),
});

export const captureScreenshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewScreenshotArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.captureScreenshot")(function* ({ tabId }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    return yield* manager.captureScreenshot(tabId);
  }),
});

export const revealArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.revealArtifact")(function* ({ path }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.revealArtifact(path);
  }),
});

export const copyArtifactToClipboard = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.copyArtifactToClipboard")(function* ({ path }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.copyArtifactToClipboard(path);
  }),
});

export const automationStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewAutomationStatusSchema,
  handler: Effect.fn("desktop.ipc.preview.automationStatus")(function* ({ tabId }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    return yield* manager.automationStatus(tabId);
  }),
});

export const automationSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: PreviewAutomationSnapshot,
  handler: Effect.fn("desktop.ipc.preview.automationSnapshot")(function* ({ tabId }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    return yield* manager.automationSnapshot(tabId);
  }),
});

export const automationClick = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL,
  payload: DesktopPreviewAutomationClickInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationClick")(function* ({ tabId, input }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.automationClick(tabId, input);
  }),
});

export const automationType = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL,
  payload: DesktopPreviewAutomationTypeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationType")(function* ({ tabId, input }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.automationType(tabId, input);
  }),
});

export const automationPress = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL,
  payload: DesktopPreviewAutomationPressInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationPress")(function* ({ tabId, input }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.automationPress(tabId, input);
  }),
});

export const automationScroll = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL,
  payload: DesktopPreviewAutomationScrollInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationScroll")(function* ({ tabId, input }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.automationScroll(tabId, input);
  }),
});

export const automationEvaluate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
  payload: DesktopPreviewAutomationEvaluateInputSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.preview.automationEvaluate")(function* ({ tabId, input }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    return yield* manager.automationEvaluate(tabId, input);
  }),
});

export const automationWaitFor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
  payload: DesktopPreviewAutomationWaitForInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationWaitFor")(function* ({ tabId, input }, event) {
    const { windowManager: manager } = yield* previewForSender(event);
    yield* manager.automationWaitFor(tabId, input);
  }),
});

export const saveRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL,
  payload: DesktopPreviewRecordingSaveInputSchema,
  result: DesktopPreviewRecordingArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.saveRecording")(function* (
    { tabId, mimeType, data },
    event,
  ) {
    const { windowManager: manager } = yield* previewForSender(event);
    return yield* manager.saveRecording(tabId, mimeType, data);
  }),
});

export const methods = [
  createTab,
  closeTab,
  registerWebview,
  navigate,
  goBack,
  goForward,
  refresh,
  zoomIn,
  zoomOut,
  resetZoom,
  hardReload,
  setColorScheme,
  setAudioMuted,
  openDevTools,
  clearCookies,
  clearCache,
  getPreviewConfig,
  setAnnotationTheme,
  pickElement,
  cancelPickElement,
  captureScreenshot,
  revealArtifact,
  copyArtifactToClipboard,
  openPictureInPicture,
  closePictureInPicture,
  automationStatus,
  automationSnapshot,
  automationClick,
  automationType,
  automationPress,
  automationScroll,
  automationEvaluate,
  automationWaitFor,
  startRecording,
  stopRecording,
  saveRecording,
] as const;
