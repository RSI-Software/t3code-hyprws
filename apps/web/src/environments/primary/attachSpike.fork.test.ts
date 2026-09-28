import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readOptionalPrimaryEnvironmentTarget, readPrimaryEnvironmentTarget } from ".";

const clientOnlyBridge = (bootstrap: unknown, getAttachedPrimaryBootstrap?: () => unknown) => ({
  getBackendModeState: () => ({
    effectiveMode: "client-only",
    configuredMode: "client-only",
    cliOverride: null,
    source: "settings",
  }),
  getLocalEnvironmentBootstraps: () => [],
  ...(getAttachedPrimaryBootstrap ? { getAttachedPrimaryBootstrap } : {}),
  ...(bootstrap === undefined ? {} : { __bootstrap: bootstrap }),
});

function installClientOnly(attached: unknown) {
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
      getAttachedPrimaryBootstrap: () => attached,
    } as unknown as DesktopBridge,
  });
}

describe("attached primary target (RSI-Software/t3code-hyprws#1350)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("promotes exactly one verified attached server to primary", () => {
    installClientOnly({
      id: "environment-local",
      label: "Local development server",
      lifecycle: "attached",
      environmentId: "environment-local",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });

    expect(readOptionalPrimaryEnvironmentTarget()).toEqual({
      source: "desktop-managed",
      target: {
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    });
    expect(readPrimaryEnvironmentTarget()?.source).toBe("desktop-managed");
  });

  it("stays hosted-static when no server is attached", () => {
    installClientOnly(null);
    expect(readOptionalPrimaryEnvironmentTarget()).toBeNull();
  });

  it("ignores non-attached or incomplete bootstraps", () => {
    installClientOnly({
      id: "primary",
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
    expect(readOptionalPrimaryEnvironmentTarget()).toBeNull();

    installClientOnly({
      id: "environment-local",
      label: "Local development server",
      lifecycle: "attached",
      environmentId: "environment-local",
      httpBaseUrl: null,
      wsBaseUrl: null,
    });
    expect(readOptionalPrimaryEnvironmentTarget()).toBeNull();
  });

  it("refreshes the cache asynchronously through the async channel", async () => {
    const refreshed = {
      id: "environment-local",
      label: "Local development server",
      lifecycle: "attached",
      environmentId: "environment-local",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    };
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
        getAttachedPrimaryBootstrap: () => null,
        refreshAttachedPrimaryBootstrap: () => Promise.resolve(refreshed),
      } as unknown as DesktopBridge,
    });
    // Sync cache is empty → hosted-static until the async refresh advances it.
    expect(readOptionalPrimaryEnvironmentTarget()).toBeNull();
    await expect(window.desktopBridge?.refreshAttachedPrimaryBootstrap?.()).resolves.toEqual(
      refreshed,
    );
  });

  it("stays hosted-static when the attached read throws (stale main state)", () => {
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
        getAttachedPrimaryBootstrap: () => {
          throw new Error("detached");
        },
      } as unknown as DesktopBridge,
    });
    expect(readOptionalPrimaryEnvironmentTarget()).toBeNull();
  });

  it("keeps the client-only guard without the attach bridge (remote-only fallback)", () => {
    vi.stubGlobal("window", {
      location: new URL("t3code://app/"),
      history: { replaceState: vi.fn() },
      desktopBridge: clientOnlyBridge(undefined) as unknown as DesktopBridge,
    });
    expect(readOptionalPrimaryEnvironmentTarget()).toBeNull();
  });

  it("classifies by the lifecycle bit, not URL text", () => {
    // An attached remote-looking (LAN-advertised) URL promotes: the
    // lifecycle bit carries locality, not the hostname.
    installClientOnly({
      id: "environment-local",
      label: "Local development server",
      lifecycle: "attached",
      environmentId: "environment-local",
      httpBaseUrl: "http://192.168.1.20:3773",
      wsBaseUrl: "ws://192.168.1.20:3773/",
    });
    expect(readOptionalPrimaryEnvironmentTarget()?.source).toBe("desktop-managed");

    // A managed-lifecycle bootstrap never promotes through the attached
    // path even when its URL is loopback text.
    installClientOnly({
      id: "environment-local",
      label: "Local development server",
      lifecycle: "managed",
      environmentId: "environment-local",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
    expect(readOptionalPrimaryEnvironmentTarget()).toBeNull();
  });
});
