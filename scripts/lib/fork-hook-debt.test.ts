// @effect-diagnostics nodeBuiltinImport:off - Pure probe logic tests.

import { assert, it } from "@effect/vitest";

import {
  buildHookDebtReport,
  groupReshapeCandidates,
  probePathHookDebt,
  renderHookDebtReport,
} from "./fork-hook-debt.ts";
import type { ForkHooksManifest } from "./fork-conflict-outcomes.ts";

const manifest = {
  "test/one": { path: "src/a.ts", anchor: { kind: "import-block" as const } },
  "test/two": { path: "src/a.ts", anchor: { kind: "after-decl" as const, symbol: "x" } },
  "test/three": { path: "src/b.ts", anchor: { kind: "import-block" as const } },
} satisfies ForkHooksManifest;

it("reads resolvable, absent, and unprobeable verdicts from the gate's own resolver", () => {
  const tip = [
    "import upstream;",
    "import fork; // fork-hook: test/one",
    "const x = start();",
    "useForkHook(); // fork-hook: test/two",
    "",
  ].join("\n");
  // The replayed commit predates the markers: same spans, bare text.
  const theirs = tip.replace(" // fork-hook: test/one", "").replace(" // fork-hook: test/two", "");
  const verdicts = probePathHookDebt("src/a.ts", manifest, theirs, tip);
  assert.deepInclude(
    verdicts.find(({ key }) => key === "test/one"),
    { status: "resolvable" },
  );
  assert.deepInclude(
    verdicts.find(({ key }) => key === "test/two"),
    { status: "resolvable" },
  );
  // A tip that no longer matches the seam reads absent, not guessed.
  const moved = probePathHookDebt("src/a.ts", manifest, "import upstream;\n", tip);
  assert.deepInclude(
    moved.find(({ key }) => key === "test/one"),
    { status: "absent" },
  );
  // No commit blob at all: unprobeable, never silently zero.
  const gone = probePathHookDebt("src/a.ts", manifest, undefined, tip);
  assert.deepInclude(
    gone.find(({ key }) => key === "test/one"),
    { status: "unprobeable" },
  );
});

it("prefers the commit's own in-file marker, as the gate does", () => {
  const tip = "import fork; // fork-hook: test/one\nconst x = 1;\n";
  const verdicts = probePathHookDebt("src/a.ts", manifest, tip, tip);
  assert.deepInclude(
    verdicts.find(({ key }) => key === "test/one"),
    { status: "resolvable" },
  );
  // The tip blob gone means no overlay, but the marker still resolves.
  const markerOnly = probePathHookDebt("src/a.ts", manifest, tip, undefined);
  assert.deepInclude(
    markerOnly.find(({ key }) => key === "test/one"),
    { status: "resolvable" },
  );
  assert.deepInclude(
    markerOnly.find(({ key }) => key === "test/two"),
    { status: "unprobeable" },
  );
});

it("calls a key the tip does not declare unprobeable", () => {
  const verdicts = probePathHookDebt(
    "src/b.ts",
    manifest,
    "import upstream;\n",
    "import upstream;\n",
  );
  assert.deepInclude(
    verdicts.find(({ key }) => key === "test/three"),
    { status: "unprobeable" },
  );
});

it("reads zero debt keys for a commit whose keys all resolve", () => {
  const tip =
    "import fork; // fork-hook: test/one\nconst x = 1;\nuseForkHook(); // fork-hook: test/two\n";
  const report = buildHookDebtReport([
    {
      commitShort: "abc1234",
      commitSha: "abc1234",
      subject: "a woven seam",
      path: "src/a.ts",
      verdicts: probePathHookDebt("src/a.ts", manifest, tip, tip),
    },
  ]);
  assert.strictEqual(report.totals.probedKeys, 2);
  assert.strictEqual(report.totals.resolvableKeys, 2);
  assert.strictEqual(report.totals.gappedCommitCount, 0);
  assert.strictEqual(report.candidates.length, 0);
});

it("groups gapped commits by overlapping tip-marked file sets into numbered candidates", () => {
  const candidates = groupReshapeCandidates([
    { short: "aaa1111", subject: "one", debtFiles: ["src/a.ts"] },
    { short: "bbb2222", subject: "two", debtFiles: ["src/a.ts", "src/b.ts"] },
    { short: "ccc3333", subject: "three", debtFiles: ["src/c.ts"] },
  ]);
  assert.strictEqual(candidates.length, 2);
  assert.deepEqual(candidates[0]?.files, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(
    candidates[0]?.commits.map(({ short }) => short),
    ["aaa1111", "bbb2222"],
  );
  assert.deepEqual(
    candidates[1]?.commits.map(({ short }) => short),
    ["ccc3333"],
  );
});

it("prints a counting unit beside every number and names first-touch as a proxy", () => {
  const report = buildHookDebtReport([
    {
      commitShort: "abc1234",
      commitSha: "abc1234",
      subject: "a woven seam",
      path: "src/a.ts",
      verdicts: probePathHookDebt("src/a.ts", manifest, undefined, "import fork;\n"),
    },
  ]);
  const text = renderHookDebtReport(report, { label: "nightly tag", ref: "v9-nightly.1" });
  assert.include(text, "nightly tag `v9-nightly.1`");
  assert.include(text, "proxy for replay position, not the truth source");
  assert.include(
    text,
    "2 key probes (0 resolvable keys, 0 absent keys, 2 unprobeable keys) across 1 commits",
  );
  assert.include(text, "1 candidates grouping 1 gapped commits");
});
