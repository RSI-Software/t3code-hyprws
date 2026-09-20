// @effect-diagnostics nodeBuiltinImport:off - The tracked baseline is read synchronously.

import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parseTestDebtBaseline, TEST_DEBT_BASELINE } from "./fork-test-debt.ts";

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

it("reads the allow-list from the baseline's own array", () => {
  const baseline = JSON.stringify({
    editedInPlace: ["apps/web/src/localApi.test.ts", "apps/web/src/keybindings.test.ts"],
    rewrittenAssertions: [{ file: "apps/web/src/never-granted.test.ts", commit: "3f9e734d640" }],
  });
  assert.deepStrictEqual([...parseTestDebtBaseline(baseline)].toSorted(), [
    "apps/web/src/keybindings.test.ts",
    "apps/web/src/localApi.test.ts",
  ]);
});

it("grants nothing when the baseline is missing, malformed, or carries no such array", () => {
  assert.deepStrictEqual([...parseTestDebtBaseline("")], []);
  assert.deepStrictEqual([...parseTestDebtBaseline("{ not json")], []);
  assert.deepStrictEqual([...parseTestDebtBaseline(JSON.stringify({ kept: ["a.test.ts"] }))], []);
  assert.deepStrictEqual([...parseTestDebtBaseline(JSON.stringify(["a.test.ts"]))], []);
});

it("reads every row of the baseline the fork actually ships", () => {
  const debt = parseTestDebtBaseline(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, TEST_DEBT_BASELINE), "utf8"),
  );
  assert.isTrue(debt.has("apps/web/src/localApi.test.ts"));
  for (const path of debt) assert.match(path, /\.test\.tsx?$/);
});
