import type { DesktopPreviewPointerEvent, DesktopPreviewRecordingFrame } from "@t3tools/contracts";
import { BrowserWindow } from "electron";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import type * as ElectronWindow from "../electron/ElectronWindow.ts";
import type * as DesktopIpc from "../ipc/DesktopIpc.ts";
import {
  HUB_WINDOW_IDENTITY,
  type WindowIdentity,
  windowIdentityKey,
} from "../window/WindowIdentity.ts";
import type {
  PreviewManager,
  PreviewManagerError,
  PreviewTabState,
  PreviewWindowManager,
} from "./Manager.ts";

export { HUB_WINDOW_IDENTITY };
export type { WindowIdentity };

/**
 * Fork-owned preview policy for desktop windows.
 *
 * The upstream preview manager still owns Chromium behavior. This module owns
 * which desktop window gets an instance, which sender may reach it, and which
 * preload receives the capability.
 */

type StateListener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;
type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;
type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>;
type OwnedStateListener = (
  identity: WindowIdentity,
  tabId: string,
  state: PreviewTabState,
) => Effect.Effect<void>;
type OwnedPointerEventListener = (
  identity: WindowIdentity,
  event: DesktopPreviewPointerEvent,
) => Effect.Effect<void>;
type OwnedRecordingFrameListener = (
  identity: WindowIdentity,
  frame: DesktopPreviewRecordingFrame,
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
}

interface WindowOperationsEntry {
  readonly identity: WindowIdentity;
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
  kind: "state-change" | "recording-frame" | "pointer-event",
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
  const entries = new Map<string, WindowOperationsEntry>();
  const entriesSemaphore = yield* Semaphore.make(1);
  const ownedStateListenersRef = yield* Ref.make<ReadonlySet<OwnedStateListener>>(new Set());
  const ownedPointerListenersRef = yield* Ref.make<ReadonlySet<OwnedPointerEventListener>>(
    new Set(),
  );
  const ownedRecordingListenersRef = yield* Ref.make<ReadonlySet<OwnedRecordingFrameListener>>(
    new Set(),
  );

  const createEntry = Effect.fn("PreviewWindowPolicy.createWindowOperations")(function* (
    identity: WindowIdentity,
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
                  listener(identity, tabId, state),
                ),
              ),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
        operations
          .subscribePointerEvents((event) =>
            Ref.get(ownedPointerListenersRef).pipe(
              Effect.flatMap((listeners) =>
                deliverOwned("pointer-event", listeners, (listener) => listener(identity, event)),
              ),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
        operations
          .subscribeRecordingFrames((frame) =>
            Ref.get(ownedRecordingListenersRef).pipe(
              Effect.flatMap((listeners) =>
                deliverOwned("recording-frame", listeners, (listener) => listener(identity, frame)),
              ),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
      ],
      { discard: true },
    ).pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
    return { identity, operations, scope } satisfies WindowOperationsEntry;
  });

  const getEntry = (identity: WindowIdentity) =>
    entriesSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const key = windowIdentityKey(identity);
        const existing = entries.get(key);
        if (existing) return existing;
        const created = yield* createEntry(identity);
        entries.set(key, created);
        return created;
      }),
    );

  const authorizeTab = Effect.fn("PreviewWindowPolicy.authorizeTab")(function* (
    entry: WindowOperationsEntry,
    tabId: string,
  ) {
    if (yield* entry.operations.hasTab(tabId)) return;
    for (const other of entries.values()) {
      if (other !== entry && (yield* other.operations.hasTab(tabId))) {
        return yield* ownershipError(tabId, windowIdentityKey(entry.identity));
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
      startRecording: (tabId) => authorized(tabId, operations.startRecording(tabId)),
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

  const forWindow = Effect.fn("PreviewWindowPolicy.forWindow")(function* (
    identity: WindowIdentity,
  ) {
    return scopedManager(yield* getEntry(identity));
  });
  const disposeEntry = Effect.fn("PreviewWindowPolicy.disposeWindow")(function* (
    identity: WindowIdentity,
    expected?: { readonly entry: WindowOperationsEntry; readonly window: BrowserWindow },
  ) {
    yield* entriesSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const key = windowIdentityKey(identity);
        const entry = entries.get(key);
        if (
          !entry ||
          (expected !== undefined && (entry !== expected.entry || entry.window !== expected.window))
        ) {
          return;
        }
        yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
        if (entries.get(key) === entry) entries.delete(key);
      }),
    );
  });
  const disposeWindow = (identity: WindowIdentity) => disposeEntry(identity);
  const setWindow = Effect.fn("PreviewWindowPolicy.setWindow")(function* (
    identity: WindowIdentity,
    window: BrowserWindow,
  ) {
    const entry = yield* getEntry(identity);
    entry.window = window;
    yield* entry.operations.setMainWindow(window);
    window.once("closed", () => {
      runFork(disposeEntry(identity, { entry, window }));
    });
  });

  const hub = yield* forWindow(HUB_WINDOW_IDENTITY);
  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(entries.values()), (entry) => Scope.close(entry.scope, Exit.void), {
      discard: true,
    }).pipe(Effect.ignore),
  );

  return {
    hub,
    setWindow,
    disposeWindow,
    forWindow,
    subscribeOwnedStateChanges: (listener: OwnedStateListener) =>
      subscribe(ownedStateListenersRef, listener),
    subscribeOwnedPointerEvents: (listener: OwnedPointerEventListener) =>
      subscribe(ownedPointerListenersRef, listener),
    subscribeOwnedRecordingFrames: (listener: OwnedRecordingFrameListener) =>
      subscribe(ownedRecordingListenersRef, listener),
    subscribeStateChanges: (listener: StateListener) =>
      subscribe(ownedStateListenersRef, (identity, tabId, state) =>
        identity.kind === "hub" ? listener(tabId, state) : Effect.void,
      ),
    subscribePointerEvents: (listener: PointerEventListener) =>
      subscribe(ownedPointerListenersRef, (identity, event) =>
        identity.kind === "hub" ? listener(event) : Effect.void,
      ),
    subscribeRecordingFrames: (listener: RecordingFrameListener) =>
      subscribe(ownedRecordingListenersRef, (identity, frame) =>
        identity.kind === "hub" ? listener(frame) : Effect.void,
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
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const identity =
    senderWindow === null ? Option.none() : yield* electronWindow.identityFor(senderWindow);
  if (Option.isNone(identity)) {
    return yield* authorizationError("unregistered-window");
  }
  const windowManager = yield* previewManager.forWindow(identity.value);
  return { identity: identity.value, previewManager, windowManager };
});

export const installEventForwarding = Effect.fn("PreviewWindowPolicy.installEventForwarding")(
  function* (
    electronWindow: ElectronWindow.ElectronWindow["Service"],
    manager: PreviewManager["Service"],
    channels: {
      readonly stateChange: string;
      readonly recordingFrame: string;
      readonly pointerEvent: string;
    },
  ) {
    const send = (identity: WindowIdentity, channel: string, ...args: readonly unknown[]) =>
      electronWindow.get(identity).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (window) => Effect.sync(() => window.webContents.send(channel, ...args)),
          }),
        ),
      );
    yield* manager.subscribeOwnedStateChanges((identity, tabId, state) =>
      send(identity, channels.stateChange, tabId, state),
    );
    yield* manager.subscribeOwnedRecordingFrames((identity, frame) =>
      send(identity, channels.recordingFrame, frame),
    );
    yield* manager.subscribeOwnedPointerEvents((identity, event) =>
      send(identity, channels.pointerEvent, event),
    );
  },
);
