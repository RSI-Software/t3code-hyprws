import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import type { PrimaryEnvironmentTargetRead } from "./platform";

/**
 * How long a vanished primary keeps its registration before removal: an
 * update restart backs up large databases, so downtime can exceed two
 * minutes, and inside the grace the env only shows offline, costing nothing.
 */
const PRIMARY_ABSENCE_GRACE_MS = 300_000;

/** Matches no endpoint signature, so a kept primary is never reused as-is. */
const ABSENT_PRIMARY_SIGNATURE = "primary-absent";

/**
 * When the poll last registered a discovered or reused primary, on a
 * monotonic clock (`performance.now()`): NTP can step the wall clock by
 * minutes while the server is down, which would end the grace early.
 */
let primarySeenAtMs: number | undefined;

/**
 * The cached primary to keep inside the grace of the last good sighting. A
 * different environment can return at the same URL, so the kept entry's
 * signature is cleared: every later poll with a target re-runs descriptor
 * discovery, and the registry refreshes it in place only when the
 * environment id still matches.
 */
export function primaryToKeepThroughAbsenceFork<Entry extends { readonly signature: string }>(
  previous: ReadonlyMap<string, Entry>,
  seenAtMs: number | undefined,
  nowMs: number,
): Entry | undefined {
  if (seenAtMs === undefined || nowMs - seenAtMs >= PRIMARY_ABSENCE_GRACE_MS) {
    return undefined;
  }
  const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
  return cached === undefined ? undefined : { ...cached, signature: ABSENT_PRIMARY_SIGNATURE };
}

/**
 * Runs after the upstream primary poll. Removal clears caches, drafts, and
 * the open route, so a successful read that left no primary registered (the
 * target vanished, or rediscovery failed transiently) right after a good
 * sighting is treated as a restart (RSI-Software/t3code-hyprws#1706): the
 * registration stays and the env shows offline. Past the grace the server is
 * really gone and the poll removes it as upstream does. Failed reads stay
 * with upstream, which already retains the cached primary.
 */
export function keepPrimaryThroughAbsenceFork<
  Entry extends { readonly signature: string; readonly registration: Registration },
  Registration,
>(
  previous: ReadonlyMap<string, Entry>,
  next: Map<string, Entry>,
  registrations: Array<Registration>,
  topologyRead: PrimaryEnvironmentTargetRead,
  nowMs = performance.now(),
): void {
  if (topologyRead._tag !== "Success") return;
  if (next.has(PRIMARY_LOCAL_ENVIRONMENT_ID)) {
    primarySeenAtMs = nowMs;
    return;
  }
  const kept = primaryToKeepThroughAbsenceFork(previous, primarySeenAtMs, nowMs);
  if (kept === undefined) return;
  next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, kept);
  registrations.push(kept.registration);
}
