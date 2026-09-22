// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import { assert, it } from "@effect/vitest";

import { hookGuardWarnings } from "./fork-hook-guard.ts";

const input = (added: ReadonlyArray<string>, path = "apps/web/src/thing.ts", tier?: string) => ({
  commit: { short: "abc1234", domain: "project-windows", ...(tier === undefined ? {} : { tier }) },
  files: [path],
  changedLines: new Map([[path, { added }]]),
  upstreamFiles: new Set([path]),
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

it("skips a formatter reflow that moves no token", () => {
  // `vp fmt` re-wrapping a landed fork line is not new fork logic: the
  // removed side carries the same lines in the same order.
  const path = "apps/web/src/thing.ts";
  assert.deepStrictEqual(
    hookGuardWarnings({
      commit: { short: "abc1234", domain: "project-windows" },
      files: [path],
      changedLines: new Map([
        [
          path,
          {
            added: ["const x = foo(", "  1,", ");"],
            removed: ["const x = foo(", "  1,", ");"],
          },
        ],
      ]),
      upstreamFiles: new Set([path]),
    }),
    [],
  );
});

it("does not call a semantic whitespace change a reflow", () => {
  // Whitespace inside a string literal is significant: changing it is a
  // behaviour change, and the exemption must not suppress the finding.
  const path = "apps/web/src/thing.ts";
  const warnings = hookGuardWarnings({
    commit: { short: "abc1234", domain: "project-windows" },
    files: [path],
    changedLines: new Map([
      [path, { added: ['const s = "a  b";'], removed: ['const s = "a b";'] }],
    ]),
    upstreamFiles: new Set([path]),
  });
  assert.equal(warnings.length, 1);
});

it("does not call relocated identical code a reflow", () => {
  // Same tokens in a different order is a move, not a rewrap: the
  // exemption requires a line-for-line rewrite.
  const path = "apps/web/src/thing.ts";
  const warnings = hookGuardWarnings({
    commit: { short: "abc1234", domain: "project-windows" },
    files: [path],
    changedLines: new Map([
      [
        path,
        {
          added: ["const a = 1;", "const b = 2;"],
          removed: ["const b = 2;", "const a = 1;"],
        },
      ],
    ]),
    upstreamFiles: new Set([path]),
  });
  assert.equal(warnings.length, 1);
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
