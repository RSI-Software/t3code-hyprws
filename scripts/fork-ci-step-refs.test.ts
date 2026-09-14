// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

// No fork script cites a fork:ci step number in its prose
// (RSI-Software/t3code-hyprws#1228). The list such a number indexes moves —
// RSI-Software/t3code-hyprws#1218 inserting `vp check` renumbered every comment
// behind it silently — so prose names the stage instead (`vp run fork:scan`,
// the additive gate). This fails when a borrowed `fork:ci step` reference
// reappears. The file set is fork-gate-headers.test.ts's.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const scriptsDir = NodePath.join(import.meta.dirname);
const libDir = NodePath.join(import.meta.dirname, "lib");

/** The fork scripts the no-borrowed-step-number rule covers. */
const forkScripts = (): ReadonlyArray<string> => {
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

const FORK_CI_STEP_REF = /fork:ci[ -]steps? [0-9]/i;

it("no fork script cites a fork:ci step number in its prose", () => {
  const scripts = forkScripts();
  assert.isAbove(scripts.length, 0, "the fork script set must not be empty");
  const citing: Array<string> = [];
  for (const path of scripts) {
    NodeFS.readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (FORK_CI_STEP_REF.test(line)) {
          citing.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepStrictEqual(
    citing,
    [],
    `these fork scripts cite a fork:ci step number — name the stage instead:\n${citing.join("\n")}`,
  );
});
