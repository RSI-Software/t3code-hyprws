import { EnvironmentId, type RunningLocalServer } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as DesktopRunningLocalServers from "./DesktopRunningLocalServers.ts";
import {
  attachedBootstrapOf,
  ATTACHED_PRIMARY_SELECTION_AUTO,
  ATTACHED_PRIMARY_SELECTION_NONE,
  DesktopAttachedPrimary,
  type DesktopAttachedPrimary as DesktopAttachedPrimaryShape,
  make,
} from "./DesktopAttachedPrimary.ts";

const environmentId = EnvironmentId.make("environment-local");
const otherEnvironmentId = EnvironmentId.make("environment-other");

const server: RunningLocalServer = {
  statePath: "/test/.t3/userdata/server-runtime.json",
  baseDir: "/test/.t3",
  variant: "userdata",
  pid: 42,
  httpBaseUrl: "http://127.0.0.1:3773",
  startedAt: "2026-01-01T00:00:00.000Z",
  environmentId,
  label: "Local development server",
};

const otherServer: RunningLocalServer = {
  ...server,
  statePath: "/test/.t3/dev/server-runtime.json",
  variant: "dev",
  pid: 43,
  httpBaseUrl: "http://127.0.0.1:3774",
  environmentId: otherEnvironmentId,
  label: "Other server",
};

const jsonResponse = (url: string, body: unknown) =>
  HttpClientResponse.fromWeb(
    HttpClientRequest.get(url),
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const tokenResponse = (accessToken: string) =>
  jsonResponse("http://127.0.0.1:3773/oauth/token", {
    access_token: accessToken,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "orchestration:read orchestration:operate terminal:operate review:write relay:read",
  });

const sessionResponse = (authenticated: boolean) =>
  jsonResponse("http://127.0.0.1:3773/api/auth/session", {
    authenticated,
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  });

const descriptorResponse = (forEnvironmentId: string) =>
  jsonResponse("http://127.0.0.1:3773/.well-known/t3/environment", {
    environmentId: forEnvironmentId,
    label: "Local development server",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: {},
  });

interface TestHarness {
  readonly service: DesktopAttachedPrimaryShape["Service"];
  readonly requests: Array<string>;
  readonly requestBodies: Array<string>;
  /** Live discovery: mutate to model a server starting, stopping, or restarting. */
  readonly live: Array<RunningLocalServer>;
}

const readRequestBodyText = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(
    request.body._tag === "Uint8Array" && request.body.text !== undefined ? request.body.text : "",
  );

const makeHarness = (input: {
  readonly servers: ReadonlyArray<RunningLocalServer>;
  readonly accessToken?: string;
  readonly sessionAuthenticated?: boolean;
  readonly descriptorEnvironmentId?: string;
  readonly pairToken?: string;
}) =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const requestBodies: Array<string> = [];
    const live = [...input.servers];
    const httpClientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          requestBodies.push(yield* readRequestBodyText(request));
          if (request.url.endsWith("/oauth/token")) {
            return tokenResponse(input.accessToken ?? "attached-bearer-token");
          }
          if (request.url.endsWith("/api/auth/session")) {
            return sessionResponse(input.sessionAuthenticated ?? true);
          }
          return descriptorResponse(
            input.descriptorEnvironmentId ?? (server.environmentId as string),
          );
        }),
      ),
    );
    const discoveryLayer = Layer.succeed(DesktopRunningLocalServers.DesktopRunningLocalServers, {
      discover: Effect.sync(() => [...live]),
      pairLocalServer: (_id: string) =>
        Effect.succeed({
          pairingUrl: `http://127.0.0.1:3773/pair#token=${input.pairToken ?? "PAIRCODE"}`,
          pairingExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
    } as unknown as DesktopRunningLocalServers.DesktopRunningLocalServers["Service"]);
    const service = yield* make.pipe(
      Effect.provide(Layer.mergeAll(discoveryLayer, httpClientLayer)),
    );
    return { service, requests, requestBodies, live } satisfies TestHarness;
  });

/**
 * A harness with real async boundaries: every mint is a numbered bearer,
 * `pairGate` can hold or fail a given `t3 pair` call, and `live` models
 * discovery. The gates are what make the lock observable: without it,
 * parallel callers reach `t3 pair` while the first is held open.
 */
const makeScenario = (input: {
  readonly sessionAuthenticated: (bearer: string) => boolean;
  readonly pairGate?: (
    call: number,
  ) => Effect.Effect<void, DesktopRunningLocalServers.LocalServerPairingError>;
}) =>
  Effect.gen(function* () {
    const live: Array<RunningLocalServer> = [server];
    const counts = { pair: 0, mint: 0 };
    const httpClientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.url.endsWith("/oauth/token")) {
            counts.mint += 1;
            return tokenResponse(`attached-bearer-token-${counts.mint}`);
          }
          if (request.url.endsWith("/api/auth/session")) {
            const authorization = Headers.get(request.headers, "authorization");
            return sessionResponse(
              Option.isSome(authorization) &&
                input.sessionAuthenticated(authorization.value.replace(/^Bearer /, "")),
            );
          }
          return descriptorResponse(server.environmentId as string);
        }),
      ),
    );
    const discoveryLayer = Layer.succeed(DesktopRunningLocalServers.DesktopRunningLocalServers, {
      discover: Effect.sync(() => [...live]),
      pairLocalServer: () =>
        Effect.gen(function* () {
          counts.pair += 1;
          yield* input.pairGate?.(counts.pair) ?? Effect.void;
          return {
            pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
            pairingExpiresAt: "2099-01-01T00:00:00.000Z",
          };
        }),
    } as unknown as DesktopRunningLocalServers.DesktopRunningLocalServers["Service"]);
    const service = yield* make.pipe(
      Effect.provide(Layer.mergeAll(discoveryLayer, httpClientLayer)),
    );
    return { service, live, counts };
  });

/** Let every runnable fiber reach its next suspension point; no clock involved. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 100; turn += 1) yield* Effect.yieldNow;
});

const restartedServer: RunningLocalServer = {
  ...server,
  pid: 99,
  startedAt: "2026-02-02T00:00:00.000Z",
};

const held = () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    return { started, release };
  });

describe("DesktopAttachedPrimary RSI-Software/t3code-hyprws#1350", () => {
  it.effect("auto-attaches exactly one verified server and serves its bearer", () =>
    Effect.gen(function* () {
      const { service, requests, requestBodies } = yield* makeHarness({ servers: [server] });
      const attached = yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO);
      assert.ok(Option.isSome(attached));
      assert.strictEqual(attached.value.environmentId, environmentId);
      assert.strictEqual(yield* service.getBearerToken, "attached-bearer-token");
      // The exchange hits /oauth/token and carries the standard scopes.
      const tokenIndex = requests.findIndex((url) => url.endsWith("/oauth/token"));
      assert.ok(tokenIndex >= 0);
      const tokenBody = requestBodies[tokenIndex] ?? "";
      for (const scope of [
        "orchestration%3Aread",
        "orchestration%3Aoperate",
        "terminal%3Aoperate",
        "source-control%3Awrite",
        "relay%3Aread",
      ]) {
        assert.ok(
          tokenBody.includes(scope),
          `expected token exchange to carry ${scope}: ${tokenBody}`,
        );
      }
    }),
  );

  it.effect("stays detached when no server or several servers are discovered", () =>
    Effect.gen(function* () {
      const { service: empty } = yield* makeHarness({ servers: [] });
      assert.ok(Option.isNone(yield* empty.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));

      const { service: several } = yield* makeHarness({ servers: [server, otherServer] });
      assert.ok(Option.isNone(yield* several.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));
      // Explicit selection still promotes exactly one verified server.
      const { service: explicit } = yield* makeHarness({
        servers: [server, otherServer],
        descriptorEnvironmentId: otherEnvironmentId as string,
      });
      const selected = yield* explicit.attach(otherEnvironmentId as string);
      assert.ok(Option.isSome(selected));
      assert.strictEqual(selected.value.environmentId, otherEnvironmentId);
    }),
  );

  it.effect("drops to hosted-static when the server restarts away", () =>
    Effect.gen(function* () {
      let live: ReadonlyArray<RunningLocalServer> = [server];
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            request.url.endsWith("/oauth/token")
              ? tokenResponse("attached-bearer-token")
              : request.url.endsWith("/api/auth/session")
                ? sessionResponse(true)
                : descriptorResponse(server.environmentId as string),
          ),
        ),
      );
      const discoveryLayer = Layer.succeed(DesktopRunningLocalServers.DesktopRunningLocalServers, {
        discover: Effect.suspend(() => Effect.succeed(live)),
        pairLocalServer: () =>
          Effect.succeed({
            pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
            pairingExpiresAt: "2099-01-01T00:00:00.000Z",
          }),
      } as unknown as DesktopRunningLocalServers.DesktopRunningLocalServers["Service"]);
      const service = yield* make.pipe(
        Effect.provide(Layer.mergeAll(discoveryLayer, httpClientLayer)),
      );

      assert.ok(Option.isSome(yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));
      // The server restarts: pid/state gone, so discovery no longer lists it.
      live = [];
      assert.ok(Option.isNone(yield* service.current));
      assert.ok(Option.isNone(yield* service.snapshot));
      const token = yield* Effect.option(service.getBearerToken);
      assert.ok(Option.isNone(token));
    }),
  );

  it.effect("drops the attachment when the endpoint moves ports", () =>
    Effect.gen(function* () {
      let live: ReadonlyArray<RunningLocalServer> = [server];
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            request.url.endsWith("/oauth/token")
              ? tokenResponse("attached-bearer-token")
              : request.url.endsWith("/api/auth/session")
                ? sessionResponse(true)
                : descriptorResponse(server.environmentId as string),
          ),
        ),
      );
      const discoveryLayer = Layer.succeed(DesktopRunningLocalServers.DesktopRunningLocalServers, {
        discover: Effect.suspend(() => Effect.succeed(live)),
        pairLocalServer: () =>
          Effect.succeed({
            pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
            pairingExpiresAt: "2099-01-01T00:00:00.000Z",
          }),
      } as unknown as DesktopRunningLocalServers.DesktopRunningLocalServers["Service"]);
      const service = yield* make.pipe(
        Effect.provide(Layer.mergeAll(discoveryLayer, httpClientLayer)),
      );

      assert.ok(Option.isSome(yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));
      live = [{ ...server, httpBaseUrl: "http://127.0.0.1:3999" }];
      assert.ok(Option.isNone(yield* service.current));
    }),
  );

  it.effect("re-mints the bearer after revocation, then drops when minting fails", () =>
    Effect.gen(function* () {
      let sessionAuthenticated = true;
      let pairingWorks = true;
      // Each exchange mints a distinct bearer so the test proves rotation,
      // not just a second successful call.
      let mintCount = 0;
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            yield* Effect.void;
            if (request.url.endsWith("/oauth/token")) {
              mintCount += 1;
              return tokenResponse(`attached-bearer-token-${mintCount}`);
            }
            if (request.url.endsWith("/api/auth/session")) {
              return sessionResponse(sessionAuthenticated);
            }
            return descriptorResponse(server.environmentId as string);
          }),
        ),
      );
      const discoveryLayer = Layer.succeed(DesktopRunningLocalServers.DesktopRunningLocalServers, {
        discover: Effect.succeed([server]),
        pairLocalServer: () =>
          pairingWorks
            ? Effect.succeed({
                pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
                pairingExpiresAt: "2099-01-01T00:00:00.000Z",
              })
            : Effect.fail(
                new DesktopRunningLocalServers.LocalServerPairingError({
                  reason: "request_failed",
                  detail: "revoked",
                }),
              ),
      } as unknown as DesktopRunningLocalServers.DesktopRunningLocalServers["Service"]);
      const service = yield* make.pipe(
        Effect.provide(Layer.mergeAll(discoveryLayer, httpClientLayer)),
      );

      const first = yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO);
      assert.ok(Option.isSome(first));
      const firstToken = yield* service.getBearerToken;
      sessionAuthenticated = false;
      const rotated = yield* service.getBearerToken;
      // Rotation proof: the re-minted bearer differs from the revoked one.
      assert.notStrictEqual(rotated, firstToken);
      assert.ok(rotated.startsWith("attached-bearer-token-"));
      // Re-mint fails too: the attachment drops so the renderer falls back
      // to hosted-static instead of retrying a dead credential.
      sessionAuthenticated = false;
      pairingWorks = false;
      const token = yield* Effect.option(service.getBearerToken);
      assert.ok(Option.isNone(token));
      assert.ok(Option.isNone(yield* service.current));
    }),
  );

  it.effect("catches a same-port restart via pid and start-time identity", () =>
    Effect.gen(function* () {
      let live: ReadonlyArray<RunningLocalServer> = [server];
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            request.url.endsWith("/oauth/token")
              ? tokenResponse("attached-bearer-token")
              : request.url.endsWith("/api/auth/session")
                ? sessionResponse(true)
                : descriptorResponse(server.environmentId as string),
          ),
        ),
      );
      const discoveryLayer = Layer.succeed(DesktopRunningLocalServers.DesktopRunningLocalServers, {
        discover: Effect.suspend(() => Effect.succeed(live)),
        pairLocalServer: () =>
          Effect.succeed({
            pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
            pairingExpiresAt: "2099-01-01T00:00:00.000Z",
          }),
      } as unknown as DesktopRunningLocalServers.DesktopRunningLocalServers["Service"]);
      const service = yield* make.pipe(
        Effect.provide(Layer.mergeAll(discoveryLayer, httpClientLayer)),
      );

      assert.ok(Option.isSome(yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));
      // Same URL, same env id — but a new pid and start time: the old server
      // is gone and its bearer must not be served against the replacement.
      live = [{ ...server, pid: 99, startedAt: "2026-02-02T00:00:00.000Z" }];
      assert.ok(Option.isNone(yield* service.current));
      assert.ok(Option.isNone(service.cached()));
      const token = yield* Effect.option(service.getBearerToken);
      assert.ok(Option.isNone(token));
    }),
  );

  it.effect("serves the verified cache synchronously and refreshes async", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ servers: [server] });
      assert.ok(Option.isNone(service.cached()));
      yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO);
      assert.ok(Option.isSome(service.cached()));
      assert.ok(Option.isSome(yield* service.refresh));
      yield* service.attach(ATTACHED_PRIMARY_SELECTION_NONE);
      assert.ok(Option.isNone(service.cached()));
    }),
  );

  it.effect("auto-attach on startup is idempotent and keeps hosted-static", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ servers: [server] });
      const first = yield* service.autoAttachOnStartup;
      assert.ok(Option.isSome(first));
      const second = yield* service.autoAttachOnStartup;
      assert.ok(Option.isSome(second));
      assert.strictEqual(second.value?.environmentId, environmentId);

      const { service: empty } = yield* makeHarness({ servers: [] });
      assert.ok(Option.isNone(yield* empty.autoAttachOnStartup));
    }),
  );

  it.effect("detaches on explicit none selection", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ servers: [server] });
      yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO);
      assert.ok(Option.isNone(yield* service.attach(ATTACHED_PRIMARY_SELECTION_NONE)));
      assert.ok(Option.isNone(yield* service.current));
    }),
  );

  it.effect("attaches a server started after launch on refresh", () =>
    Effect.gen(function* () {
      const { service, live } = yield* makeHarness({ servers: [] });
      assert.ok(Option.isNone(yield* service.autoAttachOnStartup));
      assert.ok(Option.isNone(yield* service.refreshOrAttach));
      live.push(server);
      const attached = yield* service.refreshOrAttach;
      assert.ok(Option.isSome(attached));
      assert.strictEqual(attached.value.environmentId, environmentId);
      assert.ok(Option.isSome(service.cached()));
      // A held attachment re-verifies instead of re-attaching.
      assert.ok(Option.isSome(yield* service.refreshOrAttach));
    }),
  );

  it.effect("an unauthorized reject stays detached until it restarts or is selected", () =>
    Effect.gen(function* () {
      const { service, live } = yield* makeHarness({ servers: [server] });
      assert.ok(Option.isSome(yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));
      yield* service.reject(yield* service.getBearerToken, "unauthorized");
      assert.ok(Option.isNone(service.cached()));
      assert.ok(Option.isNone(yield* Effect.option(service.getBearerToken)));
      // The same instance never re-attaches automatically: no flapping.
      assert.ok(Option.isNone(yield* service.refreshOrAttach));
      assert.ok(Option.isNone(yield* service.autoAttachOnStartup));
      // An explicit selection bypasses the auto-attach skip.
      assert.ok(Option.isSome(yield* service.attach(environmentId as string)));
      yield* service.reject(yield* service.getBearerToken, "unauthorized");
      // A restarted instance (new pid and start time) auto-attaches again.
      live.splice(0, live.length, { ...server, pid: 99, startedAt: "2026-02-02T00:00:00.000Z" });
      const restarted = yield* service.refreshOrAttach;
      assert.ok(Option.isSome(restarted));
      assert.strictEqual(restarted.value.pid, 99);
    }),
  );

  it.effect("parallel attaches from empty pair once", () =>
    Effect.gen(function* () {
      const gate = yield* held();
      const { service, counts } = yield* makeScenario({
        sessionAuthenticated: () => true,
        pairGate: (call) =>
          call === 1
            ? Deferred.succeed(gate.started, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
              )
            : Effect.void,
      });
      const first = yield* service.refreshOrAttach.pipe(Effect.forkChild);
      const second = yield* service.refreshOrAttach.pipe(Effect.forkChild);
      yield* Deferred.await(gate.started);
      yield* settle;
      // The second window is queued on the lock, not pairing in parallel.
      assert.strictEqual(counts.pair, 1);
      yield* Deferred.succeed(gate.release, undefined);
      const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.ok(Option.isSome(a) && Option.isSome(b));
      assert.strictEqual(counts.pair, 1);
      assert.strictEqual(counts.mint, 1);
    }),
  );

  it.effect("a detach during an auto-attach is not overwritten", () =>
    Effect.gen(function* () {
      const gate = yield* held();
      const { service } = yield* makeScenario({
        sessionAuthenticated: () => true,
        pairGate: () =>
          Deferred.succeed(gate.started, undefined).pipe(
            Effect.andThen(Deferred.await(gate.release)),
          ),
      });
      const attaching = yield* service.refreshOrAttach.pipe(Effect.forkChild);
      yield* Deferred.await(gate.started);
      yield* service.attach(ATTACHED_PRIMARY_SELECTION_NONE);
      yield* Deferred.succeed(gate.release, undefined);
      assert.ok(Option.isNone(yield* Fiber.join(attaching)));
      assert.ok(Option.isNone(service.cached()));
    }),
  );

  it.effect("a restart during a re-mint spares the successor from a late reject", () =>
    Effect.gen(function* () {
      const gate = yield* held();
      const { service, live, counts } = yield* makeScenario({
        // The first bearer is revoked; every later one is live.
        sessionAuthenticated: (bearer) => bearer !== "attached-bearer-token-1",
        pairGate: (call) =>
          call === 2
            ? Deferred.succeed(gate.started, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
              )
            : Effect.void,
      });
      assert.ok(Option.isSome(yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));
      const remint = yield* service.getBearerToken.pipe(Effect.forkChild);
      yield* Deferred.await(gate.started);
      // The server restarts under the held re-mint; the poll drops and re-attaches.
      live.splice(0, live.length, restartedServer);
      assert.ok(Option.isNone(yield* service.refresh));
      const reattach = yield* service.refreshOrAttach.pipe(Effect.forkChild);
      yield* Deferred.succeed(gate.release, undefined);
      // The stale re-mint never publishes over the dropped attachment.
      assert.ok(Option.isNone(yield* Fiber.join(remint).pipe(Effect.option)));
      const successor = yield* Fiber.join(reattach);
      assert.ok(Option.isSome(successor));
      assert.strictEqual(successor.value.pid, restartedServer.pid);
      const successorToken = yield* service.getBearerToken;
      assert.strictEqual(successorToken, `attached-bearer-token-${counts.mint}`);
      // The renderer's late report names the old bearer: the successor stays.
      yield* service.reject("attached-bearer-token-1", "transport");
      assert.ok(Option.isSome(service.cached()));
      assert.strictEqual(yield* service.getBearerToken, successorToken);
      assert.ok(Option.isSome(yield* service.refreshOrAttach));
    }),
  );

  it.effect("a transport-error reject backs off, then re-attaches without a restart", () =>
    Effect.gen(function* () {
      const { service, counts } = yield* makeScenario({ sessionAuthenticated: () => true });
      assert.ok(Option.isSome(yield* service.refreshOrAttach));
      yield* service.reject(yield* service.getBearerToken, "transport");
      assert.ok(Option.isNone(service.cached()));
      // One reset is not a verdict: the healthy instance waits out the backoff.
      assert.ok(Option.isNone(yield* service.refreshOrAttach));
      assert.strictEqual(counts.pair, 1);
      yield* TestClock.adjust("2 seconds");
      assert.ok(Option.isSome(yield* service.refreshOrAttach));
      assert.strictEqual(counts.pair, 2);
    }),
  );

  it.effect("a slow pair failure starts its backoff when it fails", () =>
    Effect.gen(function* () {
      const { service, counts } = yield* makeScenario({
        sessionAuthenticated: () => true,
        pairGate: (call) =>
          call === 1
            ? Effect.sleep("10 seconds").pipe(
                Effect.andThen(
                  Effect.fail(
                    new DesktopRunningLocalServers.LocalServerPairingError({
                      reason: "request_failed",
                      detail: "pairing timed out",
                    }),
                  ),
                ),
              )
            : Effect.void,
      });
      const slow = yield* Effect.option(service.refreshOrAttach).pipe(Effect.forkChild);
      yield* settle;
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(slow);
      assert.strictEqual(counts.pair, 1);
      yield* TestClock.adjust("1999 millis");
      assert.ok(Option.isNone(yield* service.refreshOrAttach));
      assert.strictEqual(counts.pair, 1);
      yield* TestClock.adjust("1 millis");
      assert.ok(Option.isSome(yield* service.refreshOrAttach));
      assert.strictEqual(counts.pair, 2);
    }),
  );

  it.effect("a failing pair backs off, and a restart retries at once", () =>
    Effect.gen(function* () {
      const failing = new Set([1, 2, 3, 4, 5, 6, 7]);
      const { service, live, counts } = yield* makeScenario({
        sessionAuthenticated: () => true,
        pairGate: (call) =>
          failing.has(call)
            ? Effect.fail(
                new DesktopRunningLocalServers.LocalServerPairingError({
                  reason: "request_failed",
                  detail: "pairing refused",
                }),
              )
            : Effect.void,
      });
      const poll = Effect.option(service.refreshOrAttach);
      yield* poll;
      assert.strictEqual(counts.pair, 1);
      // Inside the 2s window every poll skips the instance.
      yield* poll;
      yield* TestClock.adjust("1999 millis");
      yield* poll;
      assert.strictEqual(counts.pair, 1);
      // The window doubles after each failure: 2s, 4s, 8s, …
      for (const [pairs, waitMs] of [
        [2, 1],
        [3, 4_000],
        [4, 8_000],
        [5, 16_000],
        [6, 32_000],
      ] as const) {
        yield* TestClock.adjust(`${waitMs} millis`);
        yield* poll;
        assert.strictEqual(counts.pair, pairs);
      }
      // Capped at a minute, not 64s.
      yield* TestClock.adjust("60 seconds");
      yield* poll;
      assert.strictEqual(counts.pair, 7);
      // A restart is a new instance: it pairs at once, and success attaches.
      live.splice(0, live.length, restartedServer);
      assert.ok(Option.isSome(yield* service.refreshOrAttach));
      assert.strictEqual(counts.pair, 8);
    }),
  );

  it.effect("mints once under parallel bearer reads", () =>
    Effect.gen(function* () {
      const gate = yield* held();
      const { service, counts } = yield* makeScenario({
        // The attach-time bearer is revoked; every re-mint is live.
        sessionAuthenticated: (bearer) => bearer !== "attached-bearer-token-1",
        pairGate: (call) =>
          call === 2
            ? Deferred.succeed(gate.started, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
              )
            : Effect.void,
      });
      assert.ok(Option.isSome(yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));
      const first = yield* service.getBearerToken.pipe(Effect.forkChild);
      yield* Deferred.await(gate.started);
      const second = yield* service.getBearerToken.pipe(Effect.forkChild);
      yield* settle;
      // The second reader waits for the held re-mint instead of pairing too.
      assert.strictEqual(counts.pair, 2);
      yield* Deferred.succeed(gate.release, undefined);
      const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.strictEqual(a, "attached-bearer-token-2");
      assert.strictEqual(b, a);
      assert.strictEqual(counts.mint, 2);
    }),
  );

  it.effect("a racing detach wins over an in-flight re-mint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const proceed = yield* Deferred.make<void>();
        const reminting = yield* Deferred.make<void>();
        let tokenCalls = 0;
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              if (request.url.endsWith("/oauth/token")) {
                tokenCalls += 1;
                // The attach-time mint completes; only the re-mint holds
                // open so the test can detach underneath it.
                if (tokenCalls >= 2) {
                  yield* Deferred.succeed(reminting, undefined);
                  yield* Deferred.await(proceed);
                }
                return tokenResponse("attached-bearer-token-resurrected");
              }
              if (request.url.endsWith("/api/auth/session")) {
                return sessionResponse(false);
              }
              return descriptorResponse(server.environmentId as string);
            }),
          ),
        );
        const discoveryLayer = Layer.succeed(
          DesktopRunningLocalServers.DesktopRunningLocalServers,
          {
            discover: Effect.succeed([server]),
            pairLocalServer: () =>
              Effect.succeed({
                pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
                pairingExpiresAt: "2099-01-01T00:00:00.000Z",
              }),
          } as unknown as DesktopRunningLocalServers.DesktopRunningLocalServers["Service"],
        );
        const service = yield* make.pipe(
          Effect.provide(Layer.mergeAll(discoveryLayer, httpClientLayer)),
        );

        assert.ok(Option.isSome(yield* service.attach(ATTACHED_PRIMARY_SELECTION_AUTO)));
        const remint = yield* service.getBearerToken.pipe(Effect.forkChild);
        yield* Deferred.await(reminting);
        // Detach lands while the re-mint is held open; when the mint
        // completes it sees the bumped generation and refuses to publish
        // instead of resurrecting the attachment.
        assert.ok(Option.isNone(yield* service.attach(ATTACHED_PRIMARY_SELECTION_NONE)));
        yield* Deferred.succeed(proceed, undefined);
        const token = yield* Fiber.join(remint).pipe(Effect.option);
        assert.ok(Option.isNone(token));
        assert.ok(Option.isNone(yield* service.current));
      }),
    ),
  );

  it("builds an attached bootstrap carrying lifecycle and verified env id", () => {
    assert.deepStrictEqual(attachedBootstrapOf(server), {
      id: server.environmentId,
      label: server.label,
      lifecycle: "attached",
      environmentId: server.environmentId,
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
    assert.strictEqual(DesktopAttachedPrimary.key, "@t3tools/desktop/app/DesktopAttachedPrimary");
  });
});
