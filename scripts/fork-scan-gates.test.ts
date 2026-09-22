// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import { assert, it } from "@effect/vitest";

import { buildScanResult, renderScanReport, scanFailures, type ScanInput } from "./fork-scan.ts";
import {
  forkTestSibling,
  parseCommitPatches,
  significantTestLines,
  type AuthoringGuardInput,
} from "./fork-scan-authoring.ts";

const ledger = `# Fork delta

## example

### Rebase scan

| Path | Why |
| --- | --- |
| \`apps/web/src/thing.ts\` | The seam. |
`;

const baseInput = (guard?: AuthoringGuardInput): ScanInput => ({
  base: "base",
  head: "head",
  target: "target",
  commits: [
    {
      sha: "abc1234",
      short: "abc1234",
      subject: "feat: thing",
      domain: "example",
      tier: "core",
    },
  ],
  filesBySha: new Map([["abc1234", ["apps/web/src/thing.ts"]]]),
  scans: new Map([["example", ["apps/web/src/thing.ts"]]]),
  forkChanged: new Set(["apps/web/src/thing.ts"]),
  upstreamChanged: new Set(),
  ...(guard === undefined ? {} : { guard }),
});

it("stays green with no guard input", () => {
  const result = buildScanResult(baseInput());
  assert.deepStrictEqual(scanFailures(result), []);
  assert.match(renderScanReport(result), /1 commit\(s\), 0 shared file\(s\)/);
});

it("fails an additive files finding carried on the scan result", () => {
  // The CI `Fork rebase scan` step invokes `fork:scan` directly, never
  // `fork:ci`: the additive gate only gates a pull request if a finding
  // computed from the scan's own range fails the scan.
  const result = buildScanResult({
    ...baseInput(),
    additive: [
      {
        check: "files",
        path: "apps/web/src/gone.ts",
        detail: "upstream file is missing from the head tree",
      },
    ],
  });
  const failures = scanFailures(result);
  assert.isTrue(
    failures.some((failure) => failure.startsWith("additive:files: apps/web/src/gone.ts")),
  );
});

it("fails an upstream-test addition in the since range", () => {
  const raw = [
    "abc1234",
    "--- a/apps/web/src/other.test.ts",
    "+++ b/apps/web/src/other.test.ts",
    "@@ -0,0 +1 @@",
    '+it("fork case", () => {});',
    "",
  ].join("\n");
  const result = buildScanResult(
    baseInput({
      commits: [{ sha: "abc1234", short: "abc1234", domain: "example" }],
      filesBySha: new Map([["abc1234", ["apps/web/src/other.test.ts"]]]),
      patchesBySha: parseCommitPatches(raw),
      upstreamFiles: new Set(["apps/web/src/other.test.ts"]),
      upstreamTestFiles: new Set(["apps/web/src/other.test.ts"]),
      upstreamTestLines: new Map([["apps/web/src/other.test.ts", new Set()]]),
    }),
  );
  const failures = scanFailures(result);
  assert.isTrue(failures.some((failure) => failure.startsWith("upstream-test:")));
});

it("fails a replaced export matched by name across files", () => {
  const raw = [
    "abc1234",
    "--- a/apps/web/src/upstream.ts",
    "+++ b/apps/web/src/upstream.ts",
    "@@ -1 +0,0 @@",
    "-export const shared = 1;",
    "--- /dev/null",
    "+++ b/apps/web/src/upstream.fork.ts",
    "@@ -0,0 +1 @@",
    "+export const shared = 2;",
    "",
  ].join("\n");
  const result = buildScanResult(
    baseInput({
      commits: [{ sha: "abc1234", short: "abc1234", domain: "example" }],
      filesBySha: new Map([
        ["abc1234", ["apps/web/src/upstream.ts", "apps/web/src/upstream.fork.ts"]],
      ]),
      patchesBySha: parseCommitPatches(raw),
      upstreamFiles: new Set(["apps/web/src/upstream.ts"]),
      upstreamTestFiles: new Set(),
      upstreamTestLines: new Map(),
    }),
  );
  const failures = scanFailures(result);
  assert.isTrue(failures.some((failure) => failure.startsWith("replaced-export:")));
});

it("flags an unmarked insertion through the hook guard", () => {
  const raw = [
    "abc1234",
    "--- a/apps/web/src/thing.ts",
    "+++ b/apps/web/src/thing.ts",
    "@@ -1 +1,2 @@",
    "+export const forkThing = 1;",
    "",
  ].join("\n");
  const result = buildScanResult(
    baseInput({
      commits: [{ sha: "abc1234", short: "abc1234", domain: "example" }],
      filesBySha: new Map([["abc1234", ["apps/web/src/thing.ts"]]]),
      patchesBySha: parseCommitPatches(raw),
      upstreamFiles: new Set(["apps/web/src/thing.ts"]),
      upstreamTestFiles: new Set(),
      upstreamTestLines: new Map(),
    }),
  );
  assert.isTrue(result.hookDetails.some((detail) => detail.includes("outside a marked hook")));
  assert.isTrue(scanFailures(result).some((failure) => failure.startsWith("hook-guard:")));
});

it("reads the sibling name and significant lines", () => {
  assert.equal(forkTestSibling("apps/web/src/thing.test.tsx"), "apps/web/src/thing.fork.test.tsx");
  assert.deepStrictEqual(
    [...significantTestLines("// comment\n\nexpect(1).toBe(1);\n")],
    ["expect(1).toBe(1);"],
  );
  void ledger;
});
