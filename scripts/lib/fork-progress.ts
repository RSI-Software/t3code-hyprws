// @effect-diagnostics globalDate:off - Wall-clock rate limiting for stderr progress, outside any Effect runtime.
// Shared stderr progress for the long fork gates (fork-sync, rewrite-build, fold-reshape).
// These gates run for minutes on a full stack and are normally watched through `2>&1 | tee`.

/**
 * Rate-limited (>= 1s apart) stderr progress, e.g. `rewrite-build: verifying 137/275`.
 * Piping through `tee` (the normal way these gates are run) makes stderr a non-TTY pipe,
 * so this gates only on `FORK_QUIET`, never on `isTTY`.
 *
 * The throttle is per label: a phase or path boundary emits its first line immediately
 * instead of losing it to the previous phase's timestamp.
 */
export const makeProgressReporter = (prefix: string) => {
  let last = 0;
  let current: string | null = null;
  return (label: string, done: number, total: number) => {
    if (process.env.FORK_QUIET === "1") return;
    const now = Date.now();
    if (label === current && now - last < 1000) return;
    current = label;
    last = now;
    process.stderr.write(`${prefix}: ${label} ${done}/${total}\n`);
  };
};
