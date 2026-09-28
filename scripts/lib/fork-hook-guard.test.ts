// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import { assert, it } from "@effect/vitest";

import { hookGuardWarnings } from "./fork-hook-guard.ts";

// Mirrors HARNESS_DEFERRAL_FILES in ../fork-scan-authoring.ts (one shared
// list owns both guards); lib tests must not import outside scripts/lib,
// so the scan-gates suite asserts the two stay in sync.
const HARNESS_DEFERRAL_FILES: ReadonlySet<string> = new Set([
  "apps/desktop/src/window/DesktopWindow.test.ts",
  "apps/server/src/server.test.ts",
]);

const input = (
  added: ReadonlyArray<string>,
  path = "apps/web/src/thing.ts",
  tier?: string,
  upstreamLines?: ReadonlyMap<string, ReadonlySet<string>>,
) => ({
  commit: { short: "abc1234", domain: "project-windows", ...(tier === undefined ? {} : { tier }) },
  files: [path],
  changedLines: new Map([[path, { added }]]),
  upstreamFiles: new Set([path]),
  ...(upstreamLines === undefined ? {} : { upstreamLines }),
});

it("passes a marked insertion", () => {
  assert.deepStrictEqual(
    hookGuardWarnings(
      input(["import { forkThing } from './forkThing.ts'; // fork-hook: project-windows/thing"]),
    ),
    [],
  );
});

it("flags an unmarked insertion on a marker-capable path", () => {
  const warnings = hookGuardWarnings(input(["export const forkThing = 1;"]));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /outside a marked hook/);
});

it("refuses an unmarked rewrap with no exemption", () => {
  // Any unmarked edit in range is refused, full stop: a formatter
  // rewrapping a landed line is marked by a human, not exempted.
  const path = "apps/web/src/thing.ts";
  const warnings = hookGuardWarnings({
    commit: { short: "abc1234", domain: "project-windows" },
    files: [path],
    changedLines: new Map([
      [path, { added: ["const x = foo(", "  1,", ");"], removed: ["const x = foo(1);"] }],
    ]),
    upstreamFiles: new Set([path]),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /outside a marked hook/);
});

it("passes an added line the upstream target already has", () => {
  // RSI-Software/t3code-hyprws#1207: a revert to upstream text reads as a
  // fork insertion without the target-tree filter, and the named remedy
  // (wrap it in a marker) would stop the revert being a revert.
  const path = "apps/web/src/thing.ts";
  const restored = 'it("replaces the standalone explorer", () => {});';
  assert.deepStrictEqual(
    hookGuardWarnings(input([restored], path, undefined, new Map([[path, new Set([restored])]]))),
    [],
  );
});

it("still fails an unmarked insertion the upstream target lacks", () => {
  const path = "apps/web/src/thing.ts";
  const warnings = hookGuardWarnings(
    input(["export const forkThing = 1;"], path, undefined, new Map([[path, new Set()]])),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /outside a marked hook/);
});

it("passes a marked hook plus a restored line", () => {
  const path = "apps/web/src/thing.ts";
  const restored = 'it("replaces the standalone explorer", () => {});';
  assert.deepStrictEqual(
    hookGuardWarnings(
      input(
        ["export const forkThing = 1; // fork-hook: project-windows/thing", restored],
        path,
        undefined,
        new Map([[path, new Set([restored])]]),
      ),
    ),
    [],
  );
});

it("behaves as before without the map", () => {
  const warnings = hookGuardWarnings(input(["export const forkThing = 1;"]));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /outside a marked hook/);
});

it("stays silent on package.json, where no marker comment can be written", () => {
  assert.deepStrictEqual(
    hookGuardWarnings({
      commit: { short: "abc1234", domain: "project-windows" },
      files: ["package.json"],
      changedLines: new Map([["package.json", { added: ['  "fork": true,'] }]]),
      upstreamFiles: new Set(["package.json"]),
    }),
    [],
  );
});

it("exempts an upstreamable bugfix", () => {
  assert.deepStrictEqual(
    hookGuardWarnings({
      commit: { short: "abc1234", domain: "project-windows", tier: "bugfix", upstreamable: "yes" },
      files: ["apps/web/src/thing.ts"],
      changedLines: new Map([["apps/web/src/thing.ts", { added: ["export const x = 1;"] }]]),
      upstreamFiles: new Set(["apps/web/src/thing.ts"]),
    }),
    [],
  );
});

it("exempts tail-appended lines in the harness deferral files", () => {
  for (const path of [...HARNESS_DEFERRAL_FILES]) {
    assert.deepStrictEqual(
      hookGuardWarnings({
        commit: { short: "abc1234", domain: "project-windows" },
        files: [path],
        changedLines: new Map([
          [path, { added: ['it("fork case", () => {});'], tailAppend: [true] }],
        ]),
        upstreamFiles: new Set([path]),
        harnessDeferralFiles: HARNESS_DEFERRAL_FILES,
      }),
      [],
    );
  }
});

it("still refuses a mid-file insertion in a harness deferral file", () => {
  const path = "apps/desktop/src/window/DesktopWindow.test.ts";
  const warnings = hookGuardWarnings({
    commit: { short: "abc1234", domain: "project-windows" },
    files: [path],
    changedLines: new Map([[path, { added: ["if (early) return;"], tailAppend: [false] }]]),
    upstreamFiles: new Set([path]),
    harnessDeferralFiles: HARNESS_DEFERRAL_FILES,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /outside a marked hook/);
});

it("still refuses tail-appended lines outside the harness deferral files", () => {
  const path = "apps/web/src/other.test.ts";
  const warnings = hookGuardWarnings({
    commit: { short: "abc1234", domain: "project-windows" },
    files: [path],
    changedLines: new Map([[path, { added: ['it("fork case", () => {});'], tailAppend: [true] }]]),
    upstreamFiles: new Set([path]),
    harnessDeferralFiles: HARNESS_DEFERRAL_FILES,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /outside a marked hook/);
});
