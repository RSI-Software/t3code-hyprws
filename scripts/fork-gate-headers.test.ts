// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

// Every fork script names its gate in its header
// (RSI-Software/t3code-hyprws#1186): a fork:ci step, a pull-request check,
// the sync tip, the release workflow, or nothing. The set is enumerated
// from disk, so a new fork script landing bare fails here.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const scriptsDir = NodePath.join(import.meta.dirname);
const libDir = NodePath.join(import.meta.dirname, "lib");

/** The fork scripts the gate-header rule covers: fork-owned, tests excluded. */
export const forkScripts = (): ReadonlyArray<string> => {
  const roots = NodeFS.readdirSync(scriptsDir)
    .filter((entry) => entry.startsWith("fork-") && entry.endsWith(".ts"))
    .filter((entry) => !entry.endsWith(".test.ts"))
    .map((entry) => NodePath.join(scriptsDir, entry));
  const libs = NodeFS.readdirSync(libDir)
    .filter((entry) => entry.startsWith("fork-") && entry.endsWith(".ts"))
    .filter((entry) => !entry.endsWith(".test.ts"))
    .map((entry) => NodePath.join(libDir, entry));
  return [...roots, ...libs].toSorted();
};

const GATE_SCOPES = ["fork:ci", "pull-request", "sync tip", "release", "local", "none"] as const;

export const gateHeader = (source: string): string | null => {
  const line = source.split("\n").find((candidate) => candidate.startsWith("// Gate:"));
  if (line === undefined) return null;
  const scope = GATE_SCOPES.find((candidate) => line.startsWith(`// Gate: ${candidate}`));
  return scope === undefined ? null : line;
};

it("every fork script names a recognized gate in its header", () => {
  const scripts = forkScripts();
  assert.isAbove(scripts.length, 0, "the fork script set must not be empty");
  const bare: Array<string> = [];
  for (const path of scripts) {
    if (gateHeader(NodeFS.readFileSync(path, "utf8")) === null) bare.push(path);
  }
  assert.deepStrictEqual(
    bare,
    [],
    `these fork scripts carry no recognized // Gate: header: ${bare.join(", ")}`,
  );
});
