// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { LocalServerPairCommandOutput } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../bin.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { resolveHeadlessConnectionString } from "../startupAccess.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const decodePairJsonOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LocalServerPairCommandOutput),
);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(CliRuntimeLayer, TestConsole.layer));

// Console output accumulates across CLI runs within a test, and each
// Console.log call is one entry — so the latest command's output is the last
// entry, even when it spans many lines.
const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

const testDescriptor = {
  environmentId: "pair-test-environment",
  label: "pair-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
};

const withDescriptorServer = <A, E, R>(run: (origin: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(testDescriptor));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("t3 pair --json", () => {
  it.effect("prints one machine-readable object with --json", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-json-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });

        const output = yield* captureStdout(
          runCli(["pair", "--base-dir", baseDir, "--label", "Desktop", "--json"]),
        );
        const decoded = yield* decodePairJsonOutput(output);

        assert.deepEqual(Object.keys(decoded), [
          "pairingUrl",
          "token",
          "expiresAt",
          "origin",
          "environmentId",
          "label",
        ]);
        assert.equal(decoded.origin, origin);
        assert.equal(decoded.environmentId, testDescriptor.environmentId);
        assert.equal(decoded.label, testDescriptor.label);
        assert.match(String(decoded.pairingUrl), new RegExp(`^${origin}/pair#token=`));
        assert.equal(
          new URL(String(decoded.pairingUrl)).hash.slice("#token=".length),
          decoded.token,
        );
        assert.isFalse(/Pairing with|Note:|[█▀▄]/.test(output));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pairs through the recorded origin when the server has no host", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-json-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        const state = yield* makePersistedServerRuntimeState({
          config: { host: undefined, devUrl: undefined },
          port: Number(new URL(origin).port),
        });
        yield* persistServerRuntimeState({ path: statePath, state });
        assert.equal(state.origin, origin);

        const output = yield* captureStdout(
          runCli(["pair", "--base-dir", baseDir, "--label", "Desktop", "--json"]),
        );
        const decoded = yield* decodePairJsonOutput(output);

        // The desktop compares `pairingUrl.origin` to the `origin` field
        // strictly, so the two must agree inside one JSON object.
        assert.equal(new URL(String(decoded.pairingUrl)).origin, decoded.origin);
        assert.equal(decoded.origin, origin);
        assert.match(String(decoded.pairingUrl), new RegExp(`^${origin}/pair#token=`));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the upstream direct base for a wildcard host", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-json-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "0.0.0.0", devUrl: undefined },
          port: Number(new URL(origin).port),
        });
        yield* persistServerRuntimeState({ path: statePath, state });
        assert.equal(state.origin, origin);

        const output = yield* captureStdout(
          runCli(["pair", "--base-dir", baseDir, "--label", "Desktop", "--json"]),
        );
        const decoded = yield* decodePairJsonOutput(output);

        // Unchanged upstream behavior: a wildcard host still resolves the
        // pairing URL through the interface fallback — the useful URL for a
        // remote client — not the recorded loopback origin.
        const upstreamOrigin = new URL(
          resolveHeadlessConnectionString("0.0.0.0", Number(new URL(origin).port)),
        ).origin;
        assert.equal(new URL(String(decoded.pairingUrl)).origin, upstreamOrigin);
        assert.notEqual(new URL(String(decoded.pairingUrl)).origin, decoded.origin);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
