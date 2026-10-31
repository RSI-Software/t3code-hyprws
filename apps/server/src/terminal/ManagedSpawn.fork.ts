import * as Effect from "effect/Effect";

export const recordManagedSpawnFork = Effect.fn("terminal.recordManagedSpawnFork")(function* <C>(
  session: {
    managedSessionTarget: string | null;
    managedSessionIdentity: { target: string; candidate: C } | null;
  },
  target: string | null,
  candidate: C | null,
  appendNotice: (notice: string) => Effect.Effect<void>,
) {
  if (target === null) return;
  if (candidate !== null) {
    session.managedSessionTarget = target;
    session.managedSessionIdentity = { target, candidate };
    return;
  }
  yield* appendNotice(
    `zmux: attach failed for ${target} (plain shell)`, // fork-hook: zmux-estate/plain-shell-notice
  );
});
