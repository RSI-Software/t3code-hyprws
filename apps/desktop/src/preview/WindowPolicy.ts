import type {
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingInputEvent,
} from "@t3tools/contracts";
import { BrowserWindow, webContents } from "electron";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import type * as ElectronWindow from "../electron/ElectronWindow.ts";
import type * as DesktopIpc from "../ipc/DesktopIpc.ts";
import type { WindowId } from "../window/WindowId.fork.ts";
import type {
  PreviewManager,
  PreviewManagerError,
  PreviewTabState,
  PreviewWindowManager,
} from "./Manager.ts";

/**
 * Fork-owned preview policy for desktop windows.
 *
 * The upstream preview manager still owns Chromium behavior. This module owns
 * which desktop window gets an instance, which sender may reach it, and where
 * its events are delivered. Every instance is owned by one `WindowId`, except
 * the app instance behind upstream's window-less `PreviewManager` surface.
 */
export const APP_PREVIEW_OWNER = "app";
export type PreviewOwner = WindowId | typeof APP_PREVIEW_OWNER;

type StateListener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;
type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;
type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>;
type RecordingInputListener = (event: DesktopPreviewRecordingInputEvent) => Effect.Effect<void>;
type OwnedStateListener = (
  owner: PreviewOwner,
  tabId: string,
  state: PreviewTabState,
) => Effect.Effect<void>;
type OwnedPointerEventListener = (
  owner: PreviewOwner,
  event: DesktopPreviewPointerEvent,
) => Effect.Effect<void>;
type OwnedRecordingFrameListener = (
  owner: PreviewOwner,
  frame: DesktopPreviewRecordingFrame,
) => Effect.Effect<void>;
type OwnedRecordingInputListener = (
  owner: PreviewOwner,
  input: DesktopPreviewRecordingInputEvent,
) => Effect.Effect<void>;

export interface OwnedPreviewOperations extends PreviewWindowManager {
  readonly hasTab: (tabId: string) => Effect.Effect<boolean>;
  readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>;
  readonly subscribeStateChanges: (
    listener: StateListener,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly subscribePointerEvents: (
    listener: PointerEventListener,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly subscribeRecordingFrames: (
    listener: RecordingFrameListener,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly subscribeRecordingInputs: (
    listener: RecordingInputListener,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

interface WindowOperationsEntry {
  readonly owner: PreviewOwner;
  readonly operations: OwnedPreviewOperations;
  readonly scope: Scope.Closeable;
  window?: BrowserWindow;
}

const subscribe = <A>(ref: Ref.Ref<ReadonlySet<A>>, listener: A) =>
  Effect.acquireRelease(
    Ref.update(ref, (listeners) => new Set([...listeners, listener])),
    () =>
      Ref.update(ref, (listeners) => {
        const next = new Set(listeners);
        next.delete(listener);
        return next;
      }),
  ).pipe(Effect.asVoid);

const deliverOwned = <A>(
  kind: "state-change" | "recording-frame" | "recording-input" | "pointer-event",
  listeners: ReadonlySet<A>,
  deliver: (listener: A) => Effect.Effect<void>,
) =>
  Effect.forEach(
    listeners,
    (listener) =>
      Effect.suspend(() => deliver(listener)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Desktop preview event listener failed.", {
                eventKind: kind,
                cause,
              }),
        ),
      ),
    { discard: true },
  );

export const makeWindowOwnership = Effect.fn("PreviewWindowPolicy.makeWindowOwnership")(function* (
  createOperations: (scope: Scope.Closeable) => Effect.Effect<OwnedPreviewOperations>,
  ownershipError: (tabId: string, requestingWindow: string) => PreviewManagerError,
) {
  const parentScope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const entries = new Map<PreviewOwner, WindowOperationsEntry>();
  const entriesSemaphore = yield* Semaphore.make(1);
  const ownedStateListenersRef = yield* Ref.make<ReadonlySet<OwnedStateListener>>(new Set());
  const ownedPointerListenersRef = yield* Ref.make<ReadonlySet<OwnedPointerEventListener>>(
    new Set(),
  );
  const ownedRecordingListenersRef = yield* Ref.make<ReadonlySet<OwnedRecordingFrameListener>>(
    new Set(),
  );
  const ownedRecordingInputListenersRef = yield* Ref.make<ReadonlySet<OwnedRecordingInputListener>>(
    new Set(),
  );

  const createEntry = Effect.fn("PreviewWindowPolicy.createWindowOperations")(function* (
    owner: PreviewOwner,
  ): Effect.fn.Return<WindowOperationsEntry> {
    const scope = yield* Scope.fork(parentScope, "sequential");
    const operations = yield* createOperations(scope);
    yield* Effect.all(
      [
        operations
          .subscribeStateChanges((tabId, state) =>
            Ref.get(ownedStateListenersRef).pipe(
              Effect.flatMap((listeners) =>
                deliverOwned("state-change", listeners, (listener) =>
                  listener(owner, tabId, state),
                ),
              ),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
        operations
          .subscribePointerEvents((event) =>
            Ref.get(ownedPointerListenersRef).pipe(
              Effect.flatMap((listeners) =>
                deliverOwned("pointer-event", listeners, (listener) => listener(owner, event)),
              ),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
        operations
          .subscribeRecordingFrames((frame) =>
            Ref.get(ownedRecordingListenersRef).pipe(
              Effect.flatMap((listeners) =>
                deliverOwned("recording-frame", listeners, (listener) => listener(owner, frame)),
              ),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
        operations
          .subscribeRecordingInputs((input) =>
            Ref.get(ownedRecordingInputListenersRef).pipe(
              Effect.flatMap((listeners) =>
                deliverOwned("recording-input", listeners, (listener) => listener(owner, input)),
              ),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
      ],
      { discard: true },
    ).pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
    return { owner, operations, scope } satisfies WindowOperationsEntry;
  });

  // Caller must hold entriesSemaphore. Keeping this helper lock-free lets
  // setWindow publish a replacement on the entry before a stale close can inspect it.
  const getOrCreateEntryLocked = Effect.fn("PreviewWindowPolicy.getOrCreateEntryLocked")(function* (
    owner: PreviewOwner,
  ) {
    const existing = entries.get(owner);
    if (existing) return existing;
    const created = yield* createEntry(owner);
    entries.set(owner, created);
    return created;
  });
  const getEntry = (owner: PreviewOwner) =>
    entriesSemaphore.withPermits(1)(getOrCreateEntryLocked(owner));

  const authorizeTab = Effect.fn("PreviewWindowPolicy.authorizeTab")(function* (
    entry: WindowOperationsEntry,
    tabId: string,
  ) {
    if (yield* entry.operations.hasTab(tabId)) return;
    for (const other of entries.values()) {
      if (other !== entry && (yield* other.operations.hasTab(tabId))) {
        return yield* ownershipError(tabId, entry.owner);
      }
    }
  });

  const scopedManager = (entry: WindowOperationsEntry): PreviewWindowManager => {
    const operations = entry.operations;
    const authorized = <A>(tabId: string, operation: Effect.Effect<A, PreviewManagerError>) =>
      authorizeTab(entry, tabId).pipe(Effect.andThen(operation));
    return {
      createTab: operations.createTab,
      closeTab: (tabId) => authorized(tabId, operations.closeTab(tabId)),
      registerWebview: (tabId, webContentsId) =>
        authorized(tabId, operations.registerWebview(tabId, webContentsId)),
      prepareWebview: operations.prepareWebview,
      navigate: (tabId, url) => authorized(tabId, operations.navigate(tabId, url)),
      goBack: (tabId) => authorized(tabId, operations.goBack(tabId)),
      goForward: (tabId) => authorized(tabId, operations.goForward(tabId)),
      refresh: (tabId) => authorized(tabId, operations.refresh(tabId)),
      zoomIn: (tabId) => authorized(tabId, operations.zoomIn(tabId)),
      zoomOut: (tabId) => authorized(tabId, operations.zoomOut(tabId)),
      resetZoom: (tabId) => authorized(tabId, operations.resetZoom(tabId)),
      preserveGuestZooms: operations.preserveGuestZooms,
      hardReload: (tabId) => authorized(tabId, operations.hardReload(tabId)),
      setColorScheme: (tabId, colorScheme) =>
        authorized(tabId, operations.setColorScheme(tabId, colorScheme)),
      setAudioMuted: (tabId, audioMuted) =>
        authorized(tabId, operations.setAudioMuted(tabId, audioMuted)),
      openDevTools: (tabId) => authorized(tabId, operations.openDevTools(tabId)),
      setAnnotationTheme: operations.setAnnotationTheme,
      pickElement: (tabId) => authorized(tabId, operations.pickElement(tabId)),
      cancelPickElement: (tabId) => authorized(tabId, operations.cancelPickElement(tabId)),
      captureScreenshot: (tabId) => authorized(tabId, operations.captureScreenshot(tabId)),
      revealArtifact: operations.revealArtifact,
      copyArtifactToClipboard: operations.copyArtifactToClipboard,
      openPictureInPicture: (tabId) => authorized(tabId, operations.openPictureInPicture(tabId)),
      closePictureInPicture: (tabId) => authorized(tabId, operations.closePictureInPicture(tabId)),
      startRecording: (tabId, options) =>
        authorized(tabId, operations.startRecording(tabId, options)),
      stopRecording: (tabId) => authorized(tabId, operations.stopRecording(tabId)),
      saveRecording: (tabId, mimeType, data) =>
        authorized(tabId, operations.saveRecording(tabId, mimeType, data)),
      automationStatus: (tabId) => authorized(tabId, operations.automationStatus(tabId)),
      automationSnapshot: (tabId) => authorized(tabId, operations.automationSnapshot(tabId)),
      automationClick: (tabId, input) =>
        authorized(tabId, operations.automationClick(tabId, input)),
      automationType: (tabId, input) => authorized(tabId, operations.automationType(tabId, input)),
      automationPress: (tabId, input) =>
        authorized(tabId, operations.automationPress(tabId, input)),
      automationScroll: (tabId, input) =>
        authorized(tabId, operations.automationScroll(tabId, input)),
      automationEvaluate: (tabId, input) =>
        authorized(tabId, operations.automationEvaluate(tabId, input)),
      automationWaitFor: (tabId, input) =>
        authorized(tabId, operations.automationWaitFor(tabId, input)),
    };
  };

  const forWindow = Effect.fn("PreviewWindowPolicy.forWindow")(function* (owner: PreviewOwner) {
    return scopedManager(yield* getEntry(owner));
  });
  const disposeEntry = Effect.fn("PreviewWindowPolicy.disposeWindow")(function* (
    owner: PreviewOwner,
    expected?: { readonly entry: WindowOperationsEntry; readonly window: BrowserWindow },
  ) {
    yield* entriesSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const entry = entries.get(owner);
        if (
          !entry ||
          (expected !== undefined && (entry !== expected.entry || entry.window !== expected.window))
        ) {
          return;
        }
        yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
        if (entries.get(owner) === entry) entries.delete(owner);
      }),
    );
  });
  const disposeWindow = (owner: PreviewOwner) => disposeEntry(owner);
  const setWindow = Effect.fn("PreviewWindowPolicy.setWindow")(function* (
    owner: PreviewOwner,
    window: BrowserWindow,
  ) {
    const entry = yield* entriesSemaphore.withPermits(1)(
      getOrCreateEntryLocked(owner).pipe(
        Effect.tap((current) =>
          Effect.sync(() => {
            current.window = window;
          }),
        ),
      ),
    );
    yield* entry.operations.setMainWindow(window);
    window.once("closed", () => {
      runFork(disposeEntry(owner, { entry, window }));
    });
  });

  const app = yield* forWindow(APP_PREVIEW_OWNER);
  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(entries.values()), (entry) => Scope.close(entry.scope, Exit.void), {
      discard: true,
    }).pipe(Effect.ignore),
  );

  return {
    app,
    setWindow,
    disposeWindow,
    forWindow,
    subscribeOwnedStateChanges: (listener: OwnedStateListener) =>
      subscribe(ownedStateListenersRef, listener),
    subscribeOwnedPointerEvents: (listener: OwnedPointerEventListener) =>
      subscribe(ownedPointerListenersRef, listener),
    subscribeOwnedRecordingFrames: (listener: OwnedRecordingFrameListener) =>
      subscribe(ownedRecordingListenersRef, listener),
    subscribeOwnedRecordingInputs: (listener: OwnedRecordingInputListener) =>
      subscribe(ownedRecordingInputListenersRef, listener),
    subscribeStateChanges: (listener: StateListener) =>
      subscribe(ownedStateListenersRef, (owner, tabId, state) =>
        owner === APP_PREVIEW_OWNER ? listener(tabId, state) : Effect.void,
      ),
    subscribePointerEvents: (listener: PointerEventListener) =>
      subscribe(ownedPointerListenersRef, (owner, event) =>
        owner === APP_PREVIEW_OWNER ? listener(event) : Effect.void,
      ),
    subscribeRecordingFrames: (listener: RecordingFrameListener) =>
      subscribe(ownedRecordingListenersRef, (owner, frame) =>
        owner === APP_PREVIEW_OWNER ? listener(frame) : Effect.void,
      ),
    subscribeRecordingInputs: (listener: RecordingInputListener) =>
      subscribe(ownedRecordingInputListenersRef, (owner, input) =>
        owner === APP_PREVIEW_OWNER ? listener(input) : Effect.void,
      ),
  };
});

export const resolvePreviewForSender = Effect.fn("PreviewWindowPolicy.resolveSender")(function* <E>(
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
  electronWindow: ElectronWindow.ElectronWindow["Service"],
  previewManager: PreviewManager["Service"],
  authorizationError: (reason: "missing-sender" | "unregistered-window") => Effect.Effect<never, E>,
) {
  if (!event?.sender) {
    return yield* authorizationError("missing-sender");
  }
  // Upstream narrowed the invoke event to the sender's id, so the window this
  // request belongs to is resolved the way upstream resolves any id: through
  // the webContents registry, then back to its owning window.
  const senderWebContents = webContents.fromId(event.sender.id);
  const senderWindow = senderWebContents ? BrowserWindow.fromWebContents(senderWebContents) : null;
  const windowId =
    senderWindow === null ? Option.none() : yield* electronWindow.windowIdFor(senderWindow);
  if (Option.isNone(windowId)) {
    return yield* authorizationError("unregistered-window");
  }
  const windowManager = yield* previewManager.forWindow(windowId.value);
  return { windowId: windowId.value, previewManager, windowManager };
});

export const installEventForwarding = Effect.fn("PreviewWindowPolicy.installEventForwarding")(
  function* (
    electronWindow: ElectronWindow.ElectronWindow["Service"],
    manager: PreviewManager["Service"],
    channels: {
      readonly stateChange: string;
      readonly recordingFrame: string;
      readonly recordingInput: string;
      readonly pointerEvent: string;
    },
  ) {
    // The app instance has no window of its own, so its events reach no renderer.
    const send = (owner: PreviewOwner, channel: string, ...args: readonly unknown[]) =>
      (owner === APP_PREVIEW_OWNER ? Effect.succeedNone : electronWindow.getById(owner)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (window) => Effect.sync(() => window.webContents.send(channel, ...args)),
          }),
        ),
      );
    yield* manager.subscribeOwnedStateChanges((owner, tabId, state) =>
      send(owner, channels.stateChange, tabId, state),
    );
    yield* manager.subscribeOwnedRecordingFrames((owner, frame) =>
      send(owner, channels.recordingFrame, frame),
    );
    yield* manager.subscribeOwnedRecordingInputs((owner, input) =>
      send(owner, channels.recordingInput, input),
    );
    yield* manager.subscribeOwnedPointerEvents((owner, event) =>
      send(owner, channels.pointerEvent, event),
    );
  },
);
