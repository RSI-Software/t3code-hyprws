import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { canReuseCachedPlatformRegistration, type PrimaryEnvironmentTargetRead } from "./platform";
import {
  keepPrimaryThroughAbsenceFork,
  primaryToKeepThroughAbsenceFork,
} from "./primaryAbsenceGrace.fork";

describe("primary absence grace", () => {
  const signature = "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/";
  const cached = { signature, registration: {} as never };
  type Entry = typeof cached;
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);
  const absent = { _tag: "Success", target: null } as const;
  const present = {
    _tag: "Success",
    target: {
      source: "desktop-managed",
      target: { httpBaseUrl: "http://127.0.0.1:3773/", wsBaseUrl: "ws://127.0.0.1:3773/" },
    },
  } as const;

  /**
   * One platform poll: `discovered` is what the upstream primary branch put in
   * `next` (reused or discovered); omit it for an absent target or a failed
   * discovery. Returns the primary the poll registers.
   */
  const makePoller = () => {
    let cache: ReadonlyMap<string, Entry> = new Map();
    return (read: PrimaryEnvironmentTargetRead, nowMs: number, discovered?: Entry) => {
      const next = new Map<string, Entry>();
      const registrations: Array<never> = [];
      if (discovered !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, discovered);
        registrations.push(discovered.registration);
      }
      keepPrimaryThroughAbsenceFork(cache, next, registrations, read, nowMs);
      cache = next;
      const primary = next.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
      expect(registrations).toEqual(primary === undefined ? [] : [primary.registration]);
      return primary;
    };
  };

  it("keeps a recently seen primary through a restart gap", () => {
    expect(primaryToKeepThroughAbsenceFork(previous, 10_000, 309_999)?.registration).toBe(
      cached.registration,
    );
  });

  it("rediscovers a primary that reappears at the same endpoint after an absence", () => {
    // Environment A is seen, goes absent, and something returns at the same
    // URL: it may be environment B, so the kept entry must not short-circuit
    // descriptor discovery the way an unchanged endpoint signature would.
    const poll = makePoller();
    poll(present, 10_000, cached);
    const kept = poll(absent, 13_000);
    expect(kept?.registration).toBe(cached.registration);
    expect(canReuseCachedPlatformRegistration(kept!, signature, 16_000)).toBe(false);
    // An absence that never interrupted the endpoint keeps upstream reuse.
    expect(canReuseCachedPlatformRegistration(cached, signature, 16_000)).toBe(true);
  });

  it("keeps the primary through failed rediscovery until the original grace ends", () => {
    const poll = makePoller();
    poll(present, 10_000, cached);
    // Absent, then the target returns but descriptor discovery times out,
    // then absent again: every poll keeps the registration, and it stays
    // unreusable so each later target poll retries discovery.
    for (const [read, nowMs] of [
      [absent, 13_000],
      [present, 16_000],
      [absent, 19_000],
      [present, 309_999],
    ] as const) {
      const kept = poll(read, nowMs);
      expect(kept?.registration).toBe(cached.registration);
      expect(canReuseCachedPlatformRegistration(kept!, signature, nowMs)).toBe(false);
    }
    // Failed rediscovery never extends the grace of the last good sighting.
    expect(poll(present, 310_000)).toBeUndefined();
  });

  it("restarts the grace once rediscovery succeeds", () => {
    const poll = makePoller();
    poll(present, 10_000, cached);
    poll(absent, 13_000);
    poll(present, 200_000, cached);
    expect(poll(absent, 499_999)?.registration).toBe(cached.registration);
    expect(poll(absent, 500_000)).toBeUndefined();
  });

  it("never keeps a primary that was never seen", () => {
    expect(primaryToKeepThroughAbsenceFork(previous, undefined, 0)).toBeUndefined();
  });

  it("leaves failed topology reads to the upstream poll", () => {
    const poll = makePoller();
    poll(present, 10_000, cached);
    expect(poll({ _tag: "Failure", cause: new Error("IPC") }, 13_000)).toBeUndefined();
  });
});
