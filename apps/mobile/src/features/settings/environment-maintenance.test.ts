import { AuthOrchestrationOperateScope, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  findEnvironmentUpdate,
  supportsEnvironmentUpdate,
} from "./environment-maintenance";

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex-personal",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-23T00:00:00.000Z",
  models: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    canUpdate: true,
    updateCommand: null,
    checkedAt: null,
    message: null,
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it.each([
    { scopes: ["environment:maintain"], expected: true },
    { scopes: ["orchestration:operate"], expected: false },
    { scopes: ["providers:manage"], expected: false },
  ] as const)("uses the advertised update permission for $scopes", ({ scopes, expected }) => {
    expect(
      canMaintainEnvironment(
        {
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "session",
            serverUpdateScope: "environment:maintain",
          },
          scopes,
        },
        true,
      ),
    ).toBe(expected);
  });

  it.each([
    { permissions: ["environment:maintain"], expected: true },
    { permissions: ["providers:manage"], expected: false },
    { permissions: [], expected: false },
  ] as const)(
    "honors exact permissions over legacy scopes: $permissions",
    ({ permissions, expected }) => {
      expect(
        canMaintainEnvironment(
          {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "session",
              serverUpdateScope: "environment:maintain",
            },
            scopes: ["orchestration:operate"],
            permissions,
          },
          true,
        ),
      ).toBe(expected);
    },
  );

  it("requires remote desktop update support for desktop hosts", () => {
    expect(supportsEnvironmentUpdate({})).toBe(false);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "respawn" })).toBe(true);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed" })).toBe(false);
    expect(
      supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed", desktopAppUpdate: true }),
    ).toBe(true);
  });

  it("excludes unavailable, manual, busy, and incompatible provider updates", () => {
    expect(canUpdateEnvironmentProvider(provider)).toBe(true);
    expect(canUpdateEnvironmentProvider({ ...provider, installed: false })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, availability: "unavailable" })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, versionAdvisory: undefined })).toBe(false);
    for (const latestVersionStatus of ["broken", "unsupported"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          compatibilityAdvisory: {
            status: "supported",
            latestVersionStatus,
            message: null,
            recommendedVersion: null,
            recommendedRange: null,
          },
        }),
      ).toBe(false);
    }
    for (const status of ["queued", "running"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          updateState: {
            status,
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }),
      ).toBe(false);
    }
    expect(
      canUpdateEnvironmentProvider({
        ...provider,
        versionAdvisory: {
          ...provider.versionAdvisory!,
          canUpdate: false,
        },
      }),
    ).toBe(false);
  });
});

describe("environment release checks", () => {
  const signal = new AbortController().signal;
  const feed = (...tags: ReadonlyArray<string>) =>
    new Response(
      `<feed><id>tag:github.com,2008:https://github.com/pingdotgg/t3code/releases</id>${tags
        .map((tag) => `<entry><id>tag:github.com,2008:Repository/1/${tag}</id></entry>`)
        .join("")}</feed>`,
    );

  it("reports failed checks instead of claiming the server is current", async () => {
    for (const status of [403, 429]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
      await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow(String(status));
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith(".atom") ? feed("v1.0.0") : Response.json([{ tag_name: "v1.0.0" }]),
      ),
    );
    await expect(findEnvironmentUpdate("1.0.0-nightly.20260923.1", signal)).rejects.toThrow(
      "No nightly release",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "invalid" })));
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow();
  });

  it.each(["1.0.0", "1.0.0-nightly.20260923.1", "1.0.0-preview.20260923.1"])(
    "cancels the release request for %s, including the API fallback",
    async (currentVersion) => {
      const controller = new AbortController();
      const abort = new DOMException("Update check cancelled", "AbortError");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (currentVersion.includes("preview") && url.endsWith(".atom")) return feed("v1.0.0");
          controller.abort(abort);
          init?.signal?.throwIfAborted();
          return new Response(null, { status: 500 });
        }),
      );
      await expect(findEnvironmentUpdate(currentVersion, controller.signal)).rejects.toBe(abort);
    },
  );
});
