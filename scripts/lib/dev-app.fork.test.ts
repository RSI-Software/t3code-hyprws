// @effect-diagnostics nodeBuiltinImport:off - Tests inspect disposable runtime records and the current test pid.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import { assertDevAppHomeStopped, devAppRunnerOptions, startupPairingUrl } from "./dev-app.ts";
import type { DevAppOptions } from "./dev-app-options.ts";

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-app-home-"));
  temporaryHomes.push(home);
  return home;
}

function runtimeStatePath(home: string): string {
  return NodePath.join(home, "userdata", "server-runtime.json");
}

function options(overrides: Partial<DevAppOptions> = {}): DevAppOptions {
  return { surface: "external", dryRun: false, ...overrides };
}

describe("dev app orchestration helpers", () => {
  it("forwards runner options for external, preview, and desktop surfaces", () => {
    assert.deepStrictEqual(devAppRunnerOptions(options()), [
      "--auto-bootstrap-project-from-cwd=false",
      "--browser",
    ]);
    assert.deepStrictEqual(devAppRunnerOptions(options({ surface: "preview" })), [
      "--auto-bootstrap-project-from-cwd=false",
    ]);
    assert.deepStrictEqual(
      devAppRunnerOptions(
        options({ surface: "desktop", host: "0.0.0.0", port: 14_321, dryRun: true }),
      ),
      [
        "--auto-bootstrap-project-from-cwd=false",
        "--port",
        "14321",
        "--host",
        "0.0.0.0",
        "--dry-run",
      ],
    );
  });

  it("extracts the startup pairing URL from the Effect logger syntax", () => {
    const url = "http://127.0.0.1:5733/pair#token=23456789ABCD";
    assert.equal(
      startupPairingUrl(
        `\u001b[2m[17:33:19.237] INFO (#26): Authentication required.\u001b[0m { pairingUrl: '${url}' }`,
      ),
      url,
    );
    assert.equal(startupPairingUrl(`  pairingUrl: "${url}"`), url);
    assert.isUndefined(startupPairingUrl(`Pairing URL: ${url}`));
    assert.isUndefined(startupPairingUrl("pairingUrl: https://example.test/pair#token=SECRET"));
  });

  it("accepts a missing runtime record", () => {
    assert.doesNotThrow(() => assertDevAppHomeStopped(makeHome()));
  });

  it("refuses an invalid runtime record", () => {
    const home = makeHome();
    const path = runtimeStatePath(home);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, JSON.stringify({ version: 1, pid: "not-a-pid" }));

    assert.throws(() => assertDevAppHomeStopped(home), /Invalid dev runtime record/u);
  });

  it("refuses a runtime record whose process is still alive", () => {
    const home = makeHome();
    const path = runtimeStatePath(home);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, JSON.stringify({ version: 1, pid: process.pid }));

    assert.throws(
      () => assertDevAppHomeStopped(home),
      /A dev backend already uses.+Stop its terminal/u,
    );
  });
});
