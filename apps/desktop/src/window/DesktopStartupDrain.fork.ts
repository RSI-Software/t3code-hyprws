import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import type { HyprlandPlacement as HyprlandPlacementKey } from "./HyprlandPlacement.ts";
import type * as DesktopWindowSession from "./DesktopWindowSession.ts";
import type { DesktopWindowError } from "./DesktopWindow.ts";
import type { WindowId } from "./WindowId.fork.ts";
import { isExplicitLaunchRequest, type WindowRequest } from "./WindowDispatch.fork.ts";
import { windowIdentityKey, type WindowIdentity } from "./WindowIdentity.ts";

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  makeComponentLogger("desktop-window");

// Fork-only: startup drain for restore and launch intent (RSI-Software/t3code-hyprws#1340).
// Launch intents (second launch, deep link, --project) that arrive before the
// renderer can load wait here instead of a single slot, so a second intent
// cannot evict the first. Small and fixed: bursts larger than this are
// tray-icon storms, not user intent.
export const STARTUP_INTENT_QUEUE_CAPACITY = 8;

export interface WindowOpeners {
  /** Opens a window, reusing `windowId` when the restore carried one. */
  readonly ensureIdentity: () => (
    identity: WindowIdentity,
    windowId?: WindowId,
  ) => Effect.Effect<
    { readonly window: Electron.BrowserWindow; readonly windowId: WindowId },
    DesktopWindowError
  >;
  /** The window dispatch table; every queued launch takes its row once drained. */
  readonly dispatch: () => (request: WindowRequest) => Effect.Effect<void, DesktopWindowError>;
  readonly createMainIfBackendReady: () => Effect.Effect<void, DesktopWindowError>;
}

export interface StartupDrainServices {
  readonly hyprlandPlacement: HyprlandPlacementKey["Service"];
  readonly windowSession: DesktopWindowSession.DesktopWindowSession["Service"];
}

/**
 * Fork-only: one startup drain over a restore plus a bounded queue of launch
 * intents. The restore runs exactly once (update relaunch state is consumed,
 * never repeated); every ready transition drains whatever intents are queued.
 * Readiness stays false until the drain finishes, so an intent arriving
 * mid-drain still queues instead of bypassing it. Open failures are typed,
 * never defects: one failed open fails the drain through the error channel
 * (the backend pool swallows post-readiness window-open errors, so surfacing
 * keeps the restart retry in `activate` reachable), and the losers of a
 * concurrent ready race await the winner's Deferred instead of re-polling.
 */
const makeStartupDrainImpl = Effect.gen(function* () {
  // NOTE: Queue/Ref constructors below MUST stay interruptible. Wrapping
  // this generator in Effect.uninterruptible breaks every downstream
  // consumer (33 test failures: windows never open) — see review round 2.
  const pendingIntentQueue = yield* Queue.dropping<WindowRequest>(STARTUP_INTENT_QUEUE_CAPACITY);
  // One-time update-relaunch restore: consumed by the first drain only, so a
  // later backend restart never replays it.
  const pendingRestoreRef = yield* Ref.make<readonly DesktopWindowSession.WindowRestoreEntry[]>([]);
  // False until the first drain finishes: openArguments queues while unset,
  // so readiness flips true only after restore plus queued intents open.
  // Reads and writes below always go through Ref, never a raw field: two
  // ready signals race on the runtime's async boundary, and a synchronous
  // read-then-write pair in one Effect step observing the other signal's
  // in-flight update is exactly the lost-intent race the concurrent test
  // pins. Ref.modify claims the winner slot atomically instead.
  const readyToDispatchRef = yield* Ref.make(false);
  // Completion signal for the running drain, or undefined when no drain is
  // running: a ready signal that finds a live predecessor parks on it, so
  // exactly one signal owns each consume and the loser observes the consumed
  // queue through the cold-start guard and no-ops. Claimed with a single
  // atomic Ref.modify (never a synchronous read-then-write, which the
  // concurrent ready race slips between); reset when the body finishes, so a
  // later backend restart still drains anew.
  const drainWaiters = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);

  const queueStartupIntent = Effect.fn("desktop.startupDrain.queue")(function* (
    request: WindowRequest,
  ) {
    const accepted = yield* Queue.offer(pendingIntentQueue, request);
    if (!accepted) {
      yield* logWindowWarning("startup intent queue full, dropped newest", {
        request: request.kind,
        capacity: STARTUP_INTENT_QUEUE_CAPACITY,
      });
    }
  });

  // A queued launch takes the same dispatch row it would take once ready
  // (RSI-Software/t3code-hyprws#1343), except a plain second launch: drained,
  // it only creates the primary window when none is open and never reveals
  // one. The table never reveals a window it creates either, so a cold start
  // does not take the foreground back from whatever the user moved on to
  // while the backend booted: ready-to-show reveals it.
  const openIntent = (openers: WindowOpeners, intent: WindowRequest) =>
    (intent.kind === "activate"
      ? openers.createMainIfBackendReady()
      : openers.dispatch()(intent)
    ).pipe(
      Effect.as(true as const),
      Effect.catch(() =>
        logWindowWarning("failed to open startup intent", { request: intent.kind }).pipe(
          Effect.as(false as const),
        ),
      ),
    );

  const drainPendingRestore = (services: StartupDrainServices, openers: WindowOpeners) =>
    Effect.gen(function* () {
      const entries = yield* Ref.getAndSet(pendingRestoreRef, []);
      if (entries.length === 0) return false;
      for (const entry of entries) {
        const opened = yield* Effect.exit(openers.ensureIdentity()(entry.identity, entry.windowId));
        if (Exit.isFailure(opened)) {
          yield* logWindowWarning("failed to restore window", {
            identity: windowIdentityKey(entry.identity),
          });
          continue;
        }
        const workspace = entry.workspace;
        if (workspace === null) continue;
        const { window, windowId } = opened.value;
        yield* services.hyprlandPlacement
          .claim(windowId, window.getTitle())
          .pipe(
            Effect.andThen(services.hyprlandPlacement.moveToWorkspace(windowId, workspace)),
            Effect.ignore,
          );
      }
      yield* logWindowInfo("window session reopened", { windows: entries.length });
      return true;
    });

  /**
   * Opens the consumed restore (first pass only) plus every queued intent, in
   * order, then re-polls until the queue stays empty: an intent staged
   * mid-drain (a queued signal arriving while the first window opens) joins
   * this drain instead of stranding until the next ready transition, which
   * may never come. Cold start is read once before the loop — every pass
   * after the first has consumed work, so only a genuinely empty cold boot
   * invents the hub fallback. Readiness flips true only after the final
   * pass, so a signal racing the drain still queues instead of bypassing it.
   * Any open failure fails the drain through the error channel (never a
   * defect: Effect.die would bypass the backend pool's typed error contract
   * and kill supervisors that only expect DesktopWindowError); the remaining
   * intents still open first so one bad window cannot strand the rest.
   */
  const drainBody = (
    services: StartupDrainServices,
    openers: WindowOpeners,
  ): Effect.Effect<void, DesktopWindowError> =>
    Effect.gen(function* () {
      // Cold start only before any drain has finished: a later ready signal
      // (the second of renderer-ready/backend-ready, or a restart with an
      // empty queue) must not invent a hub window nobody asked for — e.g. a
      // --project launch drains its intent on the first signal, and the
      // second signal finds an empty queue. After a backend restart
      // markNotReady clears the flag, so a genuinely windowless restart still
      // recreates main through the same fallback.
      const coldStart = !(yield* Ref.get(readyToDispatchRef));
      const restored = yield* drainPendingRestore(services, openers);
      // Poll, never take: takeAll would block forever on an empty queue and
      // hang readiness when nothing was queued. Loop until a full pass polls
      // empty: an intent staged while the last opens ran joins this drain
      // instead of stranding until a next ready transition that may never
      // come. The hub fallback belongs to a genuinely empty cold boot only:
      // only the first pass can see it, because every later pass polled
      // after consuming work.
      let failed = false;
      let drainedAny = restored;
      for (;;) {
        const intents: Array<WindowRequest> = [];
        let next = yield* Queue.poll(pendingIntentQueue);
        while (Option.isSome(next)) {
          intents.push(next.value);
          next = yield* Queue.poll(pendingIntentQueue);
        }
        if (intents.length === 0) {
          if (coldStart && !drainedAny) {
            const created = yield* Effect.exit(openers.createMainIfBackendReady());
            if (created._tag === "Failure") failed = true;
            drainedAny = true;
            continue;
          }
          break;
        }
        drainedAny = true;
        for (const intent of intents) {
          if (!(yield* openIntent(openers, intent))) failed = true;
        }
      }
      yield* Ref.set(readyToDispatchRef, true);
      if (failed) {
        yield* logWindowWarning("startup drain finished with failures");
        return yield* Effect.fail(
          new ElectronWindow.ElectronWindowCreateError({
            options: {
              title: null,
              width: null,
              height: null,
              minWidth: null,
              minHeight: null,
              show: null,
              modal: null,
              frame: null,
              transparent: null,
              backgroundColor: null,
              webPreferences: {
                preload: null,
                partition: null,
                backgroundThrottling: null,
                sandbox: null,
                contextIsolation: null,
                nodeIntegration: null,
                webviewTag: null,
              },
            },
            cause: new Error("startup drain: one or more windows failed to open"),
          }),
        );
      }
    });

  // Exactly one ready signal owns each consume. The winner claims the slot
  // with a single atomic Ref.modify — never a synchronous read-then-write,
  // which the concurrent ready race slips between (both signals read empty
  // before either writes, so both run the body and split the queue; the
  // concurrent test pins this). The loser parks on the winner's completion
  // Deferred, then observes the consumed queue through the cold-start guard
  // and no-ops instead of re-polling. A semaphore cannot do this:
  // withPermit releases around every interruptible window open, so two
  // drains interleave poll/open/poll/open and split the queue. The slot
  // resets in the same step where completion is signaled, so the next
  // generation of ready signals drains anew and losers always await live.
  const drain = (
    services: StartupDrainServices,
    resolveOpeners: () => WindowOpeners,
  ): Effect.Effect<void, DesktopWindowError> =>
    Effect.flatMap(Deferred.make<void>(), (fresh) =>
      Effect.flatMap(
        // Claim the winner slot atomically: exactly one concurrent signal
        // swaps in its Deferred, every other signal observes the winner's
        // and parks. Never a synchronous read-then-write — the concurrent
        // ready race slips between the read and the write, so both signals
        // run the body and split the queue (the concurrent test pins this).
        Ref.modify(drainWaiters, (predecessor) => {
          if (predecessor !== undefined) return [predecessor, predecessor] as const;
          return [fresh, fresh] as const;
        }),
        (claimed) =>
          claimed === fresh
            ? Effect.ensuring(drainBody(services, resolveOpeners()), drainComplete(fresh))
            : Deferred.await(claimed),
      ),
    );
  /**
   * Frees the claim slot, then wakes the parked loser: reset-then-signal in
   * one uninterruptible region, so no later signal can observe a stale
   * predecessor and no loser waits on an already-completed Deferred.
   */
  const drainComplete = (done: Deferred.Deferred<void>): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.andThen(Ref.set(drainWaiters, undefined), Deferred.succeed(done, undefined)),
    );

  /**
   * Stages an argv launch for the drain. While the drain has not finished,
   * every explicit request (a deep link) queues — including ones arriving
   * mid-restore. A plain launch or callback queues too unless a restore is
   * pending, or an update relaunch would lose every project window to the hub.
   */
  const stageArguments = (
    services: StartupDrainServices,
    resolveRequest: (argv: readonly string[]) => WindowRequest,
    argv: readonly string[],
  ): Effect.Effect<
    { readonly queued: true } | { readonly queued: false; readonly request: WindowRequest }
  > =>
    Effect.gen(function* () {
      const request = resolveRequest(argv);
      if (yield* Ref.get(readyToDispatchRef)) {
        return { queued: false, request } as const;
      }
      const hasPendingRestore = (yield* Ref.get(pendingRestoreRef)).length > 0;
      if (isExplicitLaunchRequest(request) || !hasPendingRestore) {
        yield* queueStartupIntent(request);
      }
      return { queued: true } as const;
    });

  const stageRestore = (services: StartupDrainServices): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* services.windowSession.consume;
      if (entries.length === 0) return;
      yield* Ref.set(pendingRestoreRef, entries);
    });

  const markNotReady = Ref.set(readyToDispatchRef, false);

  return {
    drain,
    stageArguments,
    stageRestore,
    markNotReady,
    queueStartupIntent,
  } as const;
});

export const makeStartupDrain = makeStartupDrainImpl;

/**
 * Fork-only: lazy opener bundle for the startup drain. Resolved at drain
 * time (never at service-construction time), so the drain always calls the
 * assigned openers instead of a construction-time undefined.
 */
export const makeStartupDrainOpeners =
  (
    ensureIdentity: WindowOpeners["ensureIdentity"],
    dispatch: WindowOpeners["dispatch"],
    createMainIfBackendReady: WindowOpeners["createMainIfBackendReady"],
  ): (() => WindowOpeners) =>
  () => ({
    ensureIdentity,
    dispatch,
    createMainIfBackendReady,
  });

export type StartupDrain = Effect.Success<typeof makeStartupDrainImpl>;
