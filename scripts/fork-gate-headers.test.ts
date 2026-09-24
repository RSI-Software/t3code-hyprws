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

/** The job steps the kept fork scripts serve (RSI-Software/t3code-hyprws#1151
 * Keep table). Keys are paths relative to this test's directory; the mapped
 * `// fork job step ...` line must appear verbatim in the script's header
 * block. A script deleted here must drop its row, so the map never names a
 * file that no longer exists. */
export const forkJobStepLines: Readonly<Record<string, string>> = {
  "fork-sync.ts": "// fork job steps 1-4: fetch tag, rebase with hooks, fold fixups, one issue",
  "fork-delta.ts": "// fork job step 5: PR CI trailer gate",
  "fork-scan.ts": "// fork job step 5: PR CI rebase scan",
  "fork-ci.ts": "// fork job steps 3 and 5: the CI battery",
  "fork-upstream-refs.ts": "// fork job step 5: PR CI refs gate",
  "fork-release-version.ts": "// fork job step 3: release version",
  "fork-release-gate.ts": "// fork job step 3: release gate",
  "fork-release-delta-rev.ts": "// fork job step 3: release delta revision",
  "fork-scan-authoring.ts": "// fork job step 5: authoring guards",
  "lib/fork-hooks.ts": "// fork job steps 2 and 5: the hook seam",
  "lib/fork-hook-reapply.ts": "// fork job steps 2 and 5: hook re-apply",
  "lib/fork-policy.ts": "// fork job steps 2 and 5: fork constants",
  "lib/fork-ci-flags.ts": "// fork job steps 2 and 5: CI flag derivation",
  "lib/fork-additive-gate.ts": "// fork job step 5: additive gate",
  "lib/fork-hook-guard.ts": "// fork job steps 2 and 5: hook guard",
  "lib/fork-supersedes.ts": "// fork job step 5: supersedes declarations",
  "lib/fork-overlap.ts": "// fork job step 5: overlap predicate",
  "lib/fork-stale-delete.ts": "// fork job step 5: stale-delete check",
};

it("every kept fork script names its job step in its header", () => {
  const missing: Array<string> = [];
  for (const [relative, line] of Object.entries(forkJobStepLines)) {
    const path = NodePath.join(scriptsDir, relative);
    if (!NodeFS.existsSync(path)) {
      missing.push(`${relative}: the step map names a script that does not exist`);
      continue;
    }
    const head = NodeFS.readFileSync(path, "utf8").split("\n").slice(0, 8);
    if (!head.includes(line)) missing.push(`${relative}: expected "${line}" in the first 8 lines`);
  }
  assert.deepStrictEqual(
    missing,
    [],
    `these kept fork scripts do not name their job step:\n${missing.join("\n")}`,
  );
});
