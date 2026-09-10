import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readOptionalPrimaryEnvironmentTarget } from ".";

describe("environmentBootstrap for a client-only desktop launch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A client-only launch serves the renderer off a custom scheme and has no same-origin backend,
  // so reading a target from the window origin would point auth at an origin that serves no /api.
  it("returns no primary target without using the custom origin", () => {
    vi.stubGlobal("window", {
      location: new URL("t3code://app/"),
      history: { replaceState: vi.fn() },
      desktopBridge: {
        getBackendModeState: () => ({
          effectiveMode: "client-only",
          configuredMode: "client-only",
          cliOverride: null,
          source: "settings",
        }),
        getLocalEnvironmentBootstraps: () => [],
      },
    });

    expect(readOptionalPrimaryEnvironmentTarget()).toBeNull();
  });
});
