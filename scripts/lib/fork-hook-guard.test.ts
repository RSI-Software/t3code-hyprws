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

it("stays silent on package.json, where no marker comment can be written", () => {
  assert.deepStrictEqual(
    hookGuardWarnings({
      commit: { short: "abc1234", domain: "project-windows" },
      files: ["package.json"],
      changedLines: new Map([["package.json", { added: ['  \"fork\": true,'] }]]),
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
