import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorKeychain from "./CursorKeychain.ts";
import { CursorDriver } from "./driver.ts";

const layer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(CursorSdk.layer),
  Layer.provideMerge(
    Layer.mock(CursorAgentSdk.CursorAgentSdkRunner)({
      open: () => Effect.die("Disabled Cursor must not open an SDK session"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(CursorKeychain.CursorKeychain, {
      accessToken: Effect.die("Disabled Cursor must not read the Keychain"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Cursor must not make HTTP requests")),
    ),
  ),
);

it.layer(layer)("Cursor host environment", (it) => {
  it.effect("uses the injected host environment and lets an instance clear its inherited key", () =>
    Effect.gen(function* () {
      const previous = process.env.CURSOR_API_KEY;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          delete process.env.CURSOR_API_KEY;
        }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.CURSOR_API_KEY;
            else process.env.CURSOR_API_KEY = previous;
          }),
      );
      for (const clearKey of [false, true]) {
        const instance = yield* CursorDriver.create({
          instanceId: ProviderInstanceId.make(`cursor-injected-host-${clearKey}`),
          displayName: "Cursor",
          enabled: false,
          config: CursorDriver.defaultConfig(),
          environment: clearKey ? [{ name: "CURSOR_API_KEY", value: "", sensitive: true }] : [],
        }).pipe(
          Effect.provideService(HostProcess.Environment, { CURSOR_API_KEY: "host-test-key" }),
        );
        expect((yield* instance.snapshot.getSnapshot).setup).toMatchObject({
          canAuthenticate: clearKey,
        });
      }
    }),
  );
});
