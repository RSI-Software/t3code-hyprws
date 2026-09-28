import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type * as ElectronApp from "../electron/ElectronApp.ts";
import { STARTUP_INTENT_QUEUE_CAPACITY } from "../window/DesktopStartupDrain.fork.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logWarning } = makeComponentLogger("desktop-clerk");

// Fork-only (RSI-Software/t3code-hyprws#1340): the Clerk bridge takes the
// single-instance lock when it is created, but the app's own `second-instance`
// listener registers later, in `DesktopClerk.configure`. Electron emits into
// that gap with no app listener, dropping a second launch. This buffer
// listens from lock acquisition, stops accepting once configure's listener is
// about to take over, and replays what it held after the first launch's own
// argv is staged, so the drain opens the launches in arrival order, once each.
export const makeSecondInstanceBuffer = () => {
  const held: Array<readonly string[]> = [];
  let accepting = true;

  /** Registers the buffering listener; call where the lock is acquired. */
  const listen = (
    electronApp: ElectronApp.ElectronApp["Service"],
  ): Effect.Effect<void, never, Scope.Scope> =>
    electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
      if (!accepting) return;
      if (held.length >= STARTUP_INTENT_QUEUE_CAPACITY) return;
      held.push([...argv]);
    });

  /** Stops buffering; call right before the real listener registers. */
  const close = Effect.sync(() => {
    accepting = false;
  });

  /** Replays held launches in arrival order, exactly once. */
  const flush = <E>(openArguments: (argv: readonly string[]) => Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      accepting = false;
      const pending = held.splice(0);
      for (const argv of pending) {
        yield* openArguments(argv).pipe(
          Effect.catchCause((cause) =>
            logWarning("failed to open buffered second-instance arguments", {
              argv: [...argv],
              error: Cause.pretty(cause),
            }),
          ),
        );
      }
    });

  return { listen, close, flush } as const;
};

/** The desktop process's one buffer: Electron's lock is process-global too. */
export const desktopSecondInstanceBuffer = makeSecondInstanceBuffer();
