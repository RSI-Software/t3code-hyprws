import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import type * as DesktopWindowSession from "./DesktopWindowSession.ts";
import type { DesktopWindowError } from "./DesktopWindow.ts";
import { isExplicitLaunchRequest, type WindowRequest } from "./WindowDispatch.fork.ts";

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  makeComponentLogger("desktop-window");

// Launch intents (second launch, deep link, --project) that arrive before the
// renderer can load queue here, so a second intent cannot evict the first.
// Small and fixed: larger bursts are tray-icon storms, not user intent.
const STARTUP_INTENT_QUEUE_CAPACITY = 8;

export interface WindowOpeners {
  /**
   * Opens one restored window: always a new window, under its previous id when
   * the manifest carried one, placed at map time by its own title token.
   */
  readonly restore: () => (
    entry: DesktopWindowSession.WindowRestoreEntry,
  ) => Effect.Effect<unknown, DesktopWindowError>;
  /** The window dispatch table; every queued launch takes its row once drained. */
  readonly dispatch: () => (request: WindowRequest) => Effect.Effect<void, DesktopWindowError>;
  readonly createMainIfBackendReady: () => Effect.Effect<void, DesktopWindowError>;
}

export interface StartupDrainServices {
  readonly windowSession: DesktopWindowSession.DesktopWindowSession["Service"];
}

/**
 * One startup drain over a run-once restore plus queued launch intents; every
 * ready transition drains the queue, and readiness stays false until it ends.
 * A failed open fails the drain as a typed error, never a defect, which keeps
 * the restart retry in `activate` reachable.
 */
const makeStartupDrainImpl = Effect.gen(function* () {
  // NOTE: Queue/Ref constructors below MUST stay interruptible. Wrapping
  // this generator in Effect.uninterruptible breaks every downstream
  // consumer (33 test failures: windows never open) — see review round 2.
  const pendingIntentQueue = yield* Queue.dropping<WindowRequest>(STARTUP_INTENT_QUEUE_CAPACITY);
  // One-time update-relaunch restore: consumed by the first drain only, so a
  // later backend restart never replays it.
  const pendingRestoreRef = yield* Ref.make<readonly DesktopWindowSession.WindowRestoreEntry[]>([]);
  // False until the first drain finishes, so openArguments queues meanwhile.
  // Always accessed through Ref, never a raw field: two ready signals race on
  // the async boundary, and a raw read-then-write loses intents (the
  // concurrent test pins this).
  const readyToDispatchRef = yield* Ref.make(false);
  // Completion signal of the running drain, or undefined when idle. A ready
  // signal that finds one parks on it, so exactly one signal owns each consume.
  // Claimed with one atomic Ref.modify and reset when the body finishes, so a
  // later backend restart drains anew.
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

  // A queued launch takes its normal dispatch row, except a plain second launch,
  // which only creates the primary window when none is open. Neither reveals a
  // window it creates, so a cold start never steals the foreground back;
  // ready-to-show reveals it.
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

  // Whether any restored window opened: when none did, the cold-start
  // fallback below still opens one window.
  const drainPendingRestore = Effect.fn("DesktopStartupDrain.drainPendingRestore")(function* (
    openers: WindowOpeners,
  ) {
    const entries = yield* Ref.getAndSet(pendingRestoreRef, []);
    if (entries.length === 0) return false;
    let opened = 0;
    for (const entry of entries) {
      const exit = yield* Effect.exit(openers.restore()(entry));
      if (Exit.isFailure(exit)) {
        yield* logWindowWarning("failed to restore window", {
          seeded: entry.seed !== "all-projects",
        });
        continue;
      }
      opened += 1;
    }
    yield* logWindowInfo("window session reopened", { windows: opened, of: entries.length });
    return opened > 0;
  });

  /**
   * Opens the restore plus queued intents, re-polling until empty so an intent
   * staged mid-drain is not stranded. Open failures fail the drain as a typed
   * DesktopWindowError (Effect.die would kill supervisors), but only after the
   * remaining intents open, so one bad window cannot strand the rest.
   */
  const drainBody = Effect.fn("DesktopStartupDrain.drainBody")(function* (
    services: StartupDrainServices,
    openers: WindowOpeners,
  ): Effect.fn.Return<void, DesktopWindowError> {
    // Cold start only before any drain has finished, so a later ready signal
    // with an empty queue never invents a hub window. markNotReady clears the
    // flag on backend restart, so a windowless restart still recreates main.
    const coldStart = !(yield* Ref.get(readyToDispatchRef));
    const restored = yield* drainPendingRestore(openers);
    // Poll, never take: takeAll blocks forever on an empty queue. Loop until a
    // pass polls empty so intents staged mid-drain join it. Only the first pass
    // can see a genuinely empty cold boot and open the hub fallback.
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
      return yield* new ElectronWindow.ElectronWindowCreateError({
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
      });
    }
  });

  // Exactly one ready signal owns each consume; losers park on the winner's
  // Deferred. Not a semaphore: withPermit releases around each interruptible
  // window open, so two drains would interleave and split the queue. The slot
  // resets as completion is signaled, so the next ready signals drain anew.
  const drain = (
    services: StartupDrainServices,
    resolveOpeners: () => WindowOpeners,
  ): Effect.Effect<void, DesktopWindowError> =>
    Effect.flatMap(Deferred.make<void>(), (fresh) =>
      Effect.flatMap(
        // Atomic claim: a read-then-write lets both racing signals run the
        // body and split the queue (the concurrent test pins this).
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
  const stageArguments = Effect.fn("DesktopStartupDrain.stageArguments")(function* (
    services: StartupDrainServices,
    resolveRequest: (argv: readonly string[]) => WindowRequest,
    argv: readonly string[],
  ): Effect.fn.Return<
    { readonly queued: true } | { readonly queued: false; readonly request: WindowRequest }
  > {
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

  // Loads the windows an update relaunch left behind, queued until the backend is
  // ready. It runs before `stageArguments`, so an explicit launch intent still wins.
  const stageRestore = Effect.fn("DesktopStartupDrain.stageRestore")(function* (
    services: StartupDrainServices,
  ): Effect.fn.Return<void> {
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
    restore: WindowOpeners["restore"],
    dispatch: WindowOpeners["dispatch"],
    createMainIfBackendReady: WindowOpeners["createMainIfBackendReady"],
  ): (() => WindowOpeners) =>
  () => ({
    restore,
    dispatch,
    createMainIfBackendReady,
  });

export type StartupDrain = Effect.Success<typeof makeStartupDrainImpl>;
