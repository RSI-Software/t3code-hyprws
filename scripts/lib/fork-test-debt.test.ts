// @effect-diagnostics nodeBuiltinImport:off - The fixture and the tracked report are read synchronously.

import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parseTestDivergenceDebt, TEST_DIVERGENCE_REPORT } from "./fork-test-debt.ts";

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

const report = [
  "# Fork test divergence",
  "",
  "## Summary",
  "",
  "| Class | Files |",
  "| --- | ---: |",
  "| append | 1 |",
  "",
  "## Upstream test files edited in place (2)",
  "",
  "| File | Diff | Class |",
  "| --- | --- | --- |",
  "| `apps/web/src/localApi.test.ts` | +0 / −5 | deletion |",
  "| `apps/web/src/keybindings.test.ts` | +7 / −2 | rewrite |",
  "",
  "## `deletion` rows",
  "",
  "- `apps/web/src/prose-only.test.ts` (+0 / −5) — `3f9e734d640`: narrative row, not a table row.",
  "",
  "## Fork-authored test files missing the `*.fork.test` suffix (1, kind new-file)",
  "",
  "| File | Diff | Class |",
  "| --- | --- | --- |",
  "| `apps/web/src/forkOnly.test.ts` | +97 / −0 | append (new-file) |",
  "",
].join("\n");

it("reads the allow-list from the one table that records the debt", () => {
  assert.deepStrictEqual([...parseTestDivergenceDebt(report)].toSorted(), [
    "apps/web/src/keybindings.test.ts",
    "apps/web/src/localApi.test.ts",
  ]);
});

it("grants nothing when the report is missing or carries no such table", () => {
  assert.deepStrictEqual([...parseTestDivergenceDebt("")], []);
  assert.deepStrictEqual(
    [...parseTestDivergenceDebt("# Fork test divergence\n\n## Summary\n\n| `a.test.ts` | x |\n")],
    [],
  );
});

it("reads every row of the sweep the fork actually ships", () => {
  const debt = parseTestDivergenceDebt(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, TEST_DIVERGENCE_REPORT), "utf8"),
  );
  // The heading counts the rows, so the table and its own claim have to agree.
  const heading = /^##\s+Upstream test files edited in place \((\d+)\)/m.exec(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, TEST_DIVERGENCE_REPORT), "utf8"),
  );
  assert.strictEqual(debt.size, Number(heading?.[1]));
  assert.isTrue(debt.has("apps/web/src/localApi.test.ts"));
  for (const path of debt) assert.match(path, /\.test\.tsx?$/);
});
