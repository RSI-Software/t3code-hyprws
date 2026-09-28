import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient } from "effect/unstable/http";

import { invalidateAttachedPrimaryBearerToken } from "./attachedPrimary.fork";
import { __resetDesktopPrimaryAuthForTests } from "./desktopAuth";
import { makePrimaryEnvironmentHttpLayer } from "./httpLayer";

// The attached-primary 401 contract (RSI-Software/t3code-hyprws#1350): one
// re-mint and retry; a second 401 or a transport error drops the attachment;
// managed desktop keeps upstream's bearer client untouched.
describe("attached primary stale bearer retry", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  function installBridge(
    getBearerToken: () => Promise<string>,
    effectiveMode: "client-only" | "managed" = "client-only",
  ) {
    const rejectAttachedPrimary = vi.fn((_bearerToken: string, _reason: string) =>
      Promise.resolve(),
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: new URL("t3code://app/"),
        desktopBridge: {
          getBackendModeState: () => ({
            effectiveMode,
            configuredMode: effectiveMode,
            cliOverride: null,
            source: "settings",
          }),
          getLocalEnvironmentBootstraps: () => [],
          getAttachedPrimaryBootstrap: () => ({
            id: "environment-local",
            label: "Local development server",
            lifecycle: "attached",
            environmentId: "environment-local",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773/",
          }),
          refreshAttachedPrimaryBootstrap: () => Promise.resolve(null),
          rejectAttachedPrimary,
          getLocalEnvironmentBearerToken: getBearerToken,
        } as unknown as DesktopBridge,
      },
    });
    return rejectAttachedPrimary;
  }

  const get = HttpClient.get("http://127.0.0.1:3773/api/auth/session");

  it.effect("retries once with a fresh token after a 401", () => {
    const seen: Array<string | null> = [];
    const getBearerToken = vi
      .fn()
      .mockResolvedValueOnce("stale-bearer-token")
      .mockResolvedValue("fresh-bearer-token");
    const reject = installBridge(getBearerToken);
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
      const authorization = new Request(input as RequestInfo, init).headers.get("authorization");
      seen.push(authorization);
      const status = authorization === "Bearer fresh-bearer-token" ? 200 : 401;
      return Promise.resolve(new Response(null, { status }));
    });

    return Effect.gen(function* () {
      expect((yield* get).status).toBe(200);
      expect(seen).toEqual(["Bearer stale-bearer-token", "Bearer fresh-bearer-token"]);
      expect(getBearerToken).toHaveBeenCalledTimes(2);
      expect(reject).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it.effect("a second 401 drops the attachment instead of looping", () => {
    const reject = installBridge(vi.fn().mockResolvedValue("always-stale-bearer-token"));
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
    vi.stubGlobal("fetch", fetchMock);

    return Effect.gen(function* () {
      expect((yield* get).status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(reject).toHaveBeenCalledTimes(1);
      expect(reject).toHaveBeenCalledWith("always-stale-bearer-token", "unauthorized");
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it.effect("a transport error drops the attachment", () => {
    const reject = installBridge(vi.fn().mockResolvedValue("bearer-token"));
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("connection refused")));

    return Effect.gen(function* () {
      yield* Effect.flip(get);
      expect(reject).toHaveBeenCalledTimes(1);
      expect(reject).toHaveBeenCalledWith("bearer-token", "transport");
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it.effect("a late transport error reports the bearer it sent, not a refilled one", () => {
    const getBearerToken = vi
      .fn()
      .mockResolvedValueOnce("first-bearer-token")
      .mockResolvedValue("successor-bearer-token");
    const reject = installBridge(getBearerToken);
    let failLate: (error: Error) => void = () => undefined;
    const lateSent = new Promise<void>((sent) => {
      vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
        const request = new Request(input as RequestInfo, init);
        const authorization = request.headers.get("authorization");
        if (request.url.endsWith("/late")) {
          sent();
          return new Promise<Response>((_, fail) => {
            failLate = fail;
          });
        }
        const status = authorization === "Bearer successor-bearer-token" ? 200 : 401;
        return Promise.resolve(new Response(null, { status }));
      });
    });

    return Effect.gen(function* () {
      const late = yield* HttpClient.get("http://127.0.0.1:3773/late").pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* Effect.promise(() => lateSent);
      // Another request's 401 refills the cache with the successor's bearer.
      expect((yield* get).status).toBe(200);
      failLate(new TypeError("connection reset"));
      yield* Fiber.join(late);
      expect(reject).toHaveBeenCalledTimes(1);
      expect(reject).toHaveBeenCalledWith("first-bearer-token", "transport");
      expect(getBearerToken).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it.effect("managed desktop surfaces a 401 without retry or reject", () => {
    const reject = installBridge(vi.fn().mockResolvedValue("managed-bearer-token"), "managed");
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
    vi.stubGlobal("fetch", fetchMock);

    return Effect.gen(function* () {
      expect((yield* get).status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reject).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it("invalidate re-reads once and resolves null when main has no attachment", async () => {
    installBridge(vi.fn().mockRejectedValue(new Error("not attached")));
    await expect(invalidateAttachedPrimaryBearerToken()).resolves.toBeNull();
  });
});
