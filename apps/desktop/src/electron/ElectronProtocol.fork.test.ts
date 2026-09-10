import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol static source", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
  });

  it.effect("serves packaged assets, SPA routes, HEAD requests, and CSP", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith("/index.html")) {
          return new Response("<main>T3 Code</main>", { status: 200 });
        }
        if (url.endsWith("/assets/app-123.js")) {
          return new Response("export {};", { status: 200 });
        }
        return new Response(null, { status: 404 });
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            staticRoot: "/opt/t3/apps/server/dist/client",
            clerkFrontendApiHostname: undefined,
          });
          assert.isDefined(handler);

          const root = yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/", {
                headers: { accept: "text/html" },
              }),
            ),
          );
          assert.equal(root.status, 200);
          assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
          assert.include(root.headers.get("content-security-policy") ?? "", "default-src 'self'");
          assert.equal(yield* Effect.promise(() => root.text()), "<main>T3 Code</main>");

          const asset = yield* Effect.promise(() =>
            handler!(new Request("t3code://app/assets/app-123.js")),
          );
          assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
          assert.equal(yield* Effect.promise(() => asset.text()), "export {};");

          const route = yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/settings/connections", {
                headers: { accept: "text/html" },
              }),
            ),
          );
          assert.equal(route.status, 200);
          assert.equal(yield* Effect.promise(() => route.text()), "<main>T3 Code</main>");

          const head = yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/assets/app-123.js", {
                method: "HEAD",
              }),
            ),
          );
          assert.equal(head.status, 200);
          assert.equal(yield* Effect.promise(() => head.text()), "");
        }),
      );
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("does not fall back missing assets and rejects unsafe static requests", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response(null, { status: 404 }));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            staticRoot: "/opt/t3/apps/server/dist/client",
            clerkFrontendApiHostname: undefined,
          });
          assert.isDefined(handler);

          const missingAsset = yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/assets/missing.js", {
                headers: { accept: "text/html" },
              }),
            ),
          );
          assert.equal(missingAsset.status, 404);
          assert.equal(netFetchMock.mock.calls.length, 1);

          const traversal = yield* Effect.promise(() =>
            handler!(new Request("t3code://app/%2e%2e%2fsecret.txt")),
          );
          assert.equal(traversal.status, 403);

          const unsupported = yield* Effect.promise(() =>
            handler!(new Request("t3code://app/", { method: "POST" })),
          );
          assert.equal(unsupported.status, 405);
          assert.equal(unsupported.headers.get("allow"), "GET, HEAD");
        }),
      );
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );
});
