// @effect-diagnostics nodeBuiltinImport:off - Temporary ledger fixtures use Node helpers.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { hotSeams, parseCensusFiles, parseLedger, run, type ChurnEntry } from "./fork-churn.ts";
import { parseRecord, renderRecord, type SyncReport } from "./fork-sync-state.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

const reportFixture = (): SyncReport => ({
  schemaVersion: 1,
  stage: "checked",
  repositoryRoot: "/tmp/repository",
  reportPath: "/tmp/report.json",
  recordPath: "/tmp/record.md",
  issue: { number: 1, blockingSha: A, title: "blocked" },
  candidates: [{ tag: "v1.0.0", sha: B }],
  target: { tag: "v1.0.0", sha: B },
  source: { sha: A, sharedBase: A, expectedOld: A },
  lane: { branch: "rehearse/v1.0.0", worktree: "/tmp/lane" },
  conflicts: [
    {
      commit: "123456789abc",
      subject: "feat(web): keep a pipe | in the subject",
      domain: "fork-meta",
      path: "scripts/file|name.ts",
      class: "human",
      resolution: "kept fork intent | at the moved seam",
      agentSafe: "no | human decision",
      decidedBy: "human",
    },
  ],
  orientationDecisions: [
    {
      subject: "feat(web): keep a pipe | in the subject",
      domain: "fork-meta",
      verdict: "partial",
      decidedBy: "human",
    },
    {
      subject: "fix(web): retain behavior",
      domain: "upstream-fixes",
      verdict: "keep",
      decidedBy: "agent",
    },
  ],
  verification: [{ command: "vp test run scripts/fork-churn.test.ts", result: "passed" }],
  rebasedHead: B,
  stackSize: 1,
});

it("round-trips the Conflicts and Fork commits tables rendered by renderRecord", () => {
  const parsed = parseRecord(renderRecord(reportFixture()));
  assert.deepStrictEqual(parsed.conflicts, reportFixture().conflicts);
  assert.deepStrictEqual(parsed.decisions, reportFixture().orientationDecisions);
});

it("defaults older record and ledger rows to human provenance", () => {
  const oldRecord = renderRecord(reportFixture())
    .split("\n")
    .map((line) => line.replace(/ \| (?:human|agent) \|$/, " |"))
    .join("\n");
  const parsed = parseRecord(oldRecord);
  assert.isTrue(parsed.conflicts.every(({ decidedBy }) => decidedBy === "human"));
  assert.isTrue(parsed.decisions.every(({ decidedBy }) => decidedBy === "human"));
});

it("parses the sequential rebase census table by its rendered columns", () => {
  assert.deepStrictEqual(
    parseCensusFiles(
      [
        "## Sequential rebase census",
        "",
        "| File | Hunks | Fork commit | Domain |",
        "| --- | ---: | --- | --- |",
        "| `apps/web/src/a\\|b.ts` | 2 | `1234567 feat(web): change a \\| b` | project-windows |",
        "",
      ].join("\n"),
    ),
    [{ path: "apps/web/src/a|b.ts", hunks: 2, commit: "1234567", domain: "project-windows" }],
  );
});

it("accepts zero-hunk census rows", () => {
  const rows = parseCensusFiles(
    [
      "## Sequential rebase census",
      "",
      "| File | Hunks | Fork commit | Domain |",
      "| --- | ---: | --- | --- |",
      "| `apps/web/src/routes/-chatIndexTitlebar.test.ts` | 0 | `1234567 fix(web): retain route tests` | upstream-fixes |",
      "",
    ].join("\n"),
  );
  assert.deepStrictEqual(rows, [
    {
      path: "apps/web/src/routes/-chatIndexTitlebar.test.ts",
      hunks: 0,
      commit: "1234567",
      domain: "upstream-fixes",
    },
  ]);

  const ledgerEntry: ChurnEntry = {
    tag: "v1",
    before: A,
    after: B,
    recordUrl: "https://example.test/v1",
    conflicts: [],
    decisions: [],
    censusFiles: rows,
  };
  assert.deepStrictEqual(parseLedger(JSON.stringify([ledgerEntry])), [ledgerEntry]);
});

const entry = (tag: string, conflicts: ChurnEntry["conflicts"]): ChurnEntry => ({
  tag,
  before: A,
  after: B,
  recordUrl: `https://example.test/${tag}`,
  conflicts,
  decisions: [],
  censusFiles: [],
});

const conflict = (
  path: string,
  klass: ChurnEntry["conflicts"][number]["class"],
): ChurnEntry["conflicts"][number] => ({
  path,
  commit: "1234567",
  subject: `feat: ${path}`,
  domain: "fork-meta",
  class: klass,
  resolution: "resolved",
  decidedBy: "human",
});

it("ranks hot seams by walk count, then worst class", () => {
  const seams = hotSeams([
    entry("v1", [
      conflict("repeat-generated", "generated"),
      conflict("one-human", "human"),
      conflict("one-retire", "retire-candidate"),
    ]),
    entry("v2", [conflict("repeat-generated", "generated")]),
  ]);
  assert.deepStrictEqual(
    seams.map(({ path, walkCount, worstClass }) => ({ path, walkCount, worstClass })),
    [
      { path: "repeat-generated", walkCount: 2, worstClass: "generated" },
      { path: "one-human", walkCount: 1, worstClass: "human" },
      { path: "one-retire", walkCount: 1, worstClass: "retire-candidate" },
    ],
  );
});

it("refuses append when the tag already exists", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-churn-test-"));
  const internals = NodePath.join(root, "docs", "internals");
  NodeFS.mkdirSync(internals, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(internals, "fork-churn.json"),
    `${JSON.stringify([entry("v1", [])])}\n`,
  );
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.strictEqual(
      run(
        [
          "append",
          "--record",
          "missing.md",
          "--issue",
          "1",
          "--tag",
          "v1",
          "--before",
          A,
          "--after",
          B,
        ],
        root,
      ),
      1,
    );
    assert.strictEqual(stderr, "duplicate tag: v1\n");
  } finally {
    process.stderr.write = originalWrite;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("returns exit 1 when render --check finds a stale committed document", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-churn-test-"));
  const internals = NodePath.join(root, "docs", "internals");
  NodeFS.mkdirSync(internals, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(internals, "fork-churn.json"), "[]\n");
  NodeFS.writeFileSync(
    NodePath.join(internals, "fork-delta.md"),
    "## fork-meta\n\n### Retirement condition\n",
  );
  NodeFS.writeFileSync(NodePath.join(internals, "fork-churn.md"), "stale\n");
  try {
    assert.strictEqual(run(["render", "--check"], root), 1);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
