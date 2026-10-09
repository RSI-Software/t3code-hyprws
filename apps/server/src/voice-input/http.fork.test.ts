import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSessionId,
  VOICE_INPUT_ROUTE_FORK,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as VoiceInput from "./VoiceInput.fork.ts";
import { routes } from "./http.fork.ts";

const harness = (scopes: EnvironmentAuth.AuthenticatedSession["scopes"], authenticated = true) =>
  Effect.gen(function* () {
    let calls = 0;
    const service = VoiceInput.VoiceInput.of({
      settings: Effect.die("not used"),
      configure: () => Effect.die("not used"),
      transcribe: () =>
        Effect.sync(() => {
          calls++;
          return "words";
        }),
    });
    const context = yield* Layer.build(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          authenticated
            ? Effect.succeed({
                sessionId: AuthSessionId.make("test"),
                subject: "test",
                method: "bearer-access-token",
                scopes,
              })
            : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError()),
      }),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes(service), { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    return { calls: () => calls, handler: (request: Request) => handler(request, context) };
  });
const upload = (body = new Uint8Array([1]), contentType = "audio/wav") =>
  new Request(`http://env.local${VOICE_INPUT_ROUTE_FORK}/transcribe`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });

describe("dictation HTTP boundary", () => {
  it.effect("refuses unauthenticated audio", () =>
    Effect.gen(function* () {
      const h = yield* harness([], false);
      const response = yield* Effect.promise(() => h.handler(upload()));
      expect(response.status).toBe(401);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "EnvironmentAuthInvalidError",
        code: "auth_invalid",
        reason: "missing_credential",
      });
      expect(h.calls()).toBe(0);
    }),
  );
  it.effect.each([
    { scopes: [] },
    { scopes: [AuthOrchestrationReadScope] },
    { scopes: [AuthSettingsWriteScope] },
  ])("requires operate permission", ({ scopes }) =>
    Effect.gen(function* () {
      const h = yield* harness(scopes);
      expect((yield* Effect.promise(() => h.handler(upload()))).status).toBe(403);
      expect(h.calls()).toBe(0);
    }),
  );
  it.effect("returns text without caching", () =>
    Effect.gen(function* () {
      const h = yield* harness([AuthOrchestrationOperateScope]);
      const response = yield* Effect.promise(() => h.handler(upload()));
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ text: "words" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }),
  );
  it.effect("rejects unsupported media and oversized uploads", () =>
    Effect.gen(function* () {
      const h = yield* harness([AuthOrchestrationOperateScope]);
      expect((yield* Effect.promise(() => h.handler(upload(undefined, "audio/webm")))).status).toBe(
        415,
      );
      expect(
        (yield* Effect.promise(() => h.handler(upload(new Uint8Array(16 * 1024 * 1024 + 1)))))
          .status,
      ).toBe(400);
      expect(h.calls()).toBe(0);
    }),
  );
  it.effect("requires settings permission for configuration", () =>
    Effect.gen(function* () {
      const h = yield* harness([AuthOrchestrationOperateScope]);
      const response = yield* Effect.promise(() =>
        h.handler(
          new Request(`http://env.local${VOICE_INPUT_ROUTE_FORK}/settings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        ),
      );
      expect(response.status).toBe(403);
    }),
  );
});
