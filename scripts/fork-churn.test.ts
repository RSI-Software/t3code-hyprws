// @effect-diagnostics nodeBuiltinImport:off - Temporary ledger fixtures use Node helpers.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  commentRestId,
  hotSeams,
  parseCensusFiles,
  parseLedger,
  run,
  type ChurnEntry,
} from "./fork-churn.ts";
import {
  CHURN_LEDGER_FILE,
  CHURN_REF,
  readBotRefFile,
  writeBotRefFile,
} from "./lib/fork-bot-refs.ts";
import { runCommandText } from "./lib/fork-command.ts";
import { parseSilentSeams } from "./fork-churn-ledger.ts";
import { CHURN_MARKER, renderChurnSection } from "./fork-churn-section.ts";
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

it("reads a record or ledger row written before provenance as deciding nothing", () => {
  const oldRecord = renderRecord(reportFixture())
    .split("\n")
    .map((line) => line.replace(/ \| (?:human|agent) \|$/, " |"))
    .join("\n");
  const parsed = parseRecord(oldRecord);
  assert.isTrue(parsed.conflicts.every(({ decidedBy }) => decidedBy === "TODO"));
  assert.isTrue(parsed.decisions.every(({ decidedBy }) => decidedBy === "TODO"));

  const [entry] = parseLedger(
    JSON.stringify([
      {
        tag: "v1",
        before: A,
        after: B,
        recordUrl: "https://example.test/v1",
        conflicts: [
          {
            path: "apps/web/src/a.ts",
            commit: "1234567",
            subject: "feat: a",
            domain: "fork-meta",
            class: "human",
            resolution: "resolved",
          },
        ],
        decisions: [{ subject: "feat: a", domain: "fork-meta", verdict: "keep" }],
        censusFiles: [],
      },
    ]),
  );
  assert.strictEqual(entry?.conflicts[0]?.decidedBy, "TODO");
  assert.strictEqual(entry?.decisions[0]?.decidedBy, "TODO");
});

it("counts only decision cells carrying provenance in the walks table", () => {
  const root = ledgerRepository([
    {
      tag: "v1",
      before: A,
      after: B,
      recordUrl: "https://example.test/v1",
      conflicts: [
        conflict("apps/web/src/signed.ts", "human"),
        { ...conflict("apps/web/src/unsigned.ts", "human"), decidedBy: "TODO" },
      ],
      decisions: [
        { subject: "feat: agent call", domain: "fork-meta", verdict: "keep", decidedBy: "agent" },
        { subject: "feat: nobody's call", domain: "fork-meta", verdict: "keep", decidedBy: "TODO" },
      ],
      censusFiles: [],
    },
  ]);
  const internals = NodePath.join(root, "docs", "internals");
  NodeFS.writeFileSync(
    NodePath.join(internals, "fork-delta.md"),
    "## fork-meta\n\n### Retirement condition\n",
  );
  try {
    assert.strictEqual(run(["render"], root), 0);
    const walks = NodeFS.readFileSync(NodePath.join(internals, "fork-churn.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| `v1` |"));
    // One agent decision and one human conflict; the two unprovenanced rows count on neither side.
    assert.include(walks ?? "", "| 1/1 |");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
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

it("parses the silent seams renderRecord writes", () => {
  assert.deepStrictEqual(
    parseSilentSeams(
      [
        "## Silent seams",
        "",
        "- `apps/web/src/a.ts` [behaviour]: kept the fork guard",
        "- `apps/web/src/b.ts` [type]: widened the prop",
        "",
        "## Next",
      ].join("\n"),
    ),
    [
      { path: "apps/web/src/a.ts", summary: "kept the fork guard", touchesBehaviour: true },
      { path: "apps/web/src/b.ts", summary: "widened the prop", touchesBehaviour: false },
    ],
  );
});

it("measures hot-seam deltas against the previous churn section", () => {
  const first = renderChurnSection([entry("v1", [conflict("seam", "human")])]);
  assert.include(first, CHURN_MARKER);
  assert.include(first, "| `seam` | 1 | human | — |");

  const second = renderChurnSection(
    [
      entry("v1", [conflict("seam", "human")]),
      entry("v2", [conflict("seam", "human"), conflict("fresh", "retire-candidate")]),
    ],
    first,
  );
  assert.include(second, "| `seam` | 2 | human | +1 walk |");
  assert.include(second, "| `fresh` | 1 | retire-candidate | new |");

  const third = renderChurnSection([entry("v3", [conflict("fresh", "human")])], second);
  assert.include(third, "Dropped since the last report: `seam`.");
});

it("counts the conflict class mix and decided-by split across walks", () => {
  const section = renderChurnSection([
    entry("v1", [conflict("a", "generated"), conflict("b", "human")]),
  ]);
  assert.include(section, "| generated | 1 | 50.0% |");
  assert.include(section, "| human | 1 | 50.0% |");
  assert.include(section, "| human | 2 | 0 |");
});

it("credits an unsigned row to neither side and counts it as its own", () => {
  const section = renderChurnSection([
    {
      ...entry("v1", [
        { ...conflict("signed", "generated"), decidedBy: "agent" },
        { ...conflict("unsigned", "human"), decidedBy: "TODO" },
      ]),
      decisions: [
        { subject: "feat: unsigned", domain: "fork-meta", verdict: "keep", decidedBy: "TODO" },
      ],
    },
  ]);
  assert.include(section, "| agent | 1 | 0 |");
  assert.include(section, "| human | 0 | 0 |");
  assert.include(section, "| TODO (no provenance) | 1 | 1 |");
});

/**
 * The ledger lives on a bot-owned ref, so a fixture needs a real repository with an
 * identity `git commit-tree` accepts. The ref is local only; nothing reaches a remote.
 */
const repository = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-churn-test-"));
  runCommandText("git", ["init", "--quiet", "--initial-branch", "hyprws", root], { cwd: root });
  for (const [key, value] of [
    ["user.email", "fork@example.invalid"],
    ["user.name", "fork"],
  ])
    runCommandText("git", ["config", key ?? "", value ?? ""], { cwd: root });
  NodeFS.mkdirSync(NodePath.join(root, "docs", "internals"), { recursive: true });
  return root;
};

const ledgerRepository = (entries: ReadonlyArray<ChurnEntry>): string => {
  const root = repository();
  writeBotRefFile(
    root,
    CHURN_REF,
    CHURN_LEDGER_FILE,
    `${JSON.stringify(entries, null, 2)}\n`,
    "churn: fixture",
  );
  return root;
};

it("keeps the ledger on the bot-owned ref and never on disk", () => {
  const root = ledgerRepository([entry("v1", [])]);
  try {
    assert.strictEqual(
      readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE),
      `${JSON.stringify([entry("v1", [])], null, 2)}\n`,
    );
    assert.strictEqual(
      NodeFS.existsSync(NodePath.join(root, "docs", "internals", "fork-churn.json")),
      false,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("seeds the ledger ref once and refuses a second seed", () => {
  const root = repository();
  NodeFS.writeFileSync(
    NodePath.join(root, "docs", "internals", "fork-churn.json"),
    `${JSON.stringify([entry("v1", [])])}\n`,
  );
  try {
    assert.strictEqual(run(["seed"], root), 0);
    assert.deepStrictEqual(parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE) ?? ""), [
      entry("v1", []),
    ]);
    assert.strictEqual(run(["seed"], root), 1);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses append when the tag already exists", () => {
  const root = ledgerRepository([entry("v1", [])]);
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

it("refuses to read the ledger when the bot-owned ref was never seeded", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-churn-test-"));
  runCommandText("git", ["init", "--quiet", "--initial-branch", "hyprws", root], { cwd: root });
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.strictEqual(run(["render", "--check"], root), 1);
    assert.match(stderr, /refs\/fork\/churn does not carry fork-churn\.json/);
  } finally {
    process.stderr.write = originalWrite;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("returns exit 1 when render --check finds a stale committed document", () => {
  const root = ledgerRepository([]);
  const internals = NodePath.join(root, "docs", "internals");
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

it("takes the REST comment id from the permalink, not the node id the query reports", () => {
  assert.strictEqual(
    commentRestId(
      "https://github.com/RSI-Software/t3code-hyprws/issues/481#issuecomment-5516722153",
    ),
    "5516722153",
  );
  assert.throws(() => commentRestId("IC_kwDOUADyEs8AAAABSNJ_6Q"), /carries no REST id/);
});
