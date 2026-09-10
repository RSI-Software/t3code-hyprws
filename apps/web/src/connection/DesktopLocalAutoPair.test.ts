import { EnvironmentId, type RunningLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectDesktopAutoPairTarget, shouldAttemptDesktopAutoPair } from "./DesktopLocalAutoPair";

const allowed = {
  attempted: false,
  isReady: true,
  environmentCount: 0,
  isClientOnly: true,
};

function server(id: string): RunningLocalServer {
  return {
    statePath: `/home/dev/.t3/${id}/server-runtime.json`,
    baseDir: `/home/dev/.t3/${id}`,
    variant: "userdata",
    pid: 4242,
    httpBaseUrl: "http://127.0.0.1:3773",
    startedAt: "2026-09-10T00:00:00.000Z",
    environmentId: EnvironmentId.make(id),
    label: id,
  };
}

describe("shouldAttemptDesktopAutoPair", () => {
  it("pairs a client-only launch that has no saved environment yet", () => {
    expect(shouldAttemptDesktopAutoPair(allowed)).toBe(true);
  });

  it("runs once per launch", () => {
    expect(shouldAttemptDesktopAutoPair({ ...allowed, attempted: true })).toBe(false);
  });

  it("waits for the saved environment list before deciding", () => {
    expect(shouldAttemptDesktopAutoPair({ ...allowed, isReady: false })).toBe(false);
  });

  it("leaves an existing environment alone, including one the user removed and kept removed", () => {
    expect(shouldAttemptDesktopAutoPair({ ...allowed, environmentCount: 1 })).toBe(false);
  });

  it("never pairs a managed launch, which owns its own server", () => {
    expect(shouldAttemptDesktopAutoPair({ ...allowed, isClientOnly: false })).toBe(false);
  });
});

describe("selectDesktopAutoPairTarget", () => {
  it("pairs the one server the window can reach", () => {
    const only = server("env-userdata");

    expect(selectDesktopAutoPairTarget([only])).toBe(only);
  });

  it("pairs nothing when no server is running", () => {
    expect(selectDesktopAutoPairTarget([])).toBeNull();
  });

  it("pairs nothing when several servers run, rather than guessing one", () => {
    expect(selectDesktopAutoPairTarget([server("env-userdata"), server("env-dev")])).toBeNull();
  });
});
