// @effect-diagnostics nodeBuiltinImport:off - Temporary ledger fixtures use Node helpers.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  censusChurn,
  commentRestId,
  DOCUMENT_PATH,
  hotSeams,
  parseCensusFiles,
  parseCensusTag,
  parseLedger,
  renderMarkdown,
  run,
  trunkRepairCommits,
  walkElapsedMs,
  type ChurnEntry,
} from "./fork-churn.ts";
import {
  CHURN_LEDGER_FILE,
  CHURN_REF,
  readBotRefFile,
  writeBotRefFile,
} from "./lib/fork-bot-refs.ts";
import { runCommandText } from "./lib/fork-command.ts";
import { parseSilentSeams, readChurnState } from "./fork-churn-ledger.ts";
import { isToolingRepair } from "./lib/fork-repairs.ts";
import { freezeObservation, seamRecord } from "./lib/fork-churn-seams.ts";
import { parseHostHandoff } from "./lib/fork-host-handoff.ts";
import { CHURN_MARKER, regressedSeamLines, renderChurnSection } from "./fork-churn-section.ts";
import {
  NIGHTLY_REVIEW_EVIDENCE,
  parseRecord,
  renderRecord,
  type SyncReport,
} from "./fork-sync-state.ts";

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

/**
 * A stopped walk's record keeps TODO cells even after `record-decisions` upgrades the declined
 * conflict rows: the fork-commit Action cells stay TODO (RSI-Software/t3code-hyprws#876). Only the
 * pending ledger row's parse may read such a record.
 */
it("accepts TODO fork-commit Action cells only when allowIncomplete", () => {
  // A declined seam whose subject has no orientation row: record-decisions upgrades the conflict
  // row to human, but its fork-commit Action cell stays TODO.
  const declinedSubject = "fix(web): a seam the executor declined";
  const humanResolved = renderRecord({
    ...reportFixture(),
    stage: "conflicts",
    conflicts: [{ ...reportFixture().conflicts[0]!, subject: declinedSubject }],
  });
  assert.throws(() => parseRecord(humanResolved), /Action/);
  const parsed = parseRecord(humanResolved, { allowIncomplete: true });
  assert.strictEqual(
    parsed.decisions.find((row) => row.subject === declinedSubject)?.verdict,
    "TODO",
  );
  const stillStopped = renderRecord({
    ...reportFixture(),
    stage: "conflicts",
    conflicts: [
      {
        ...reportFixture().conflicts[0]!,
        class: "TODO",
        resolution: "TODO",
        agentSafe: "TODO",
        decidedBy: "TODO",
      },
    ],
  });
  assert.throws(() => parseRecord(stillStopped), /remains incomplete/);
  assert.strictEqual(
    parseRecord(stillStopped, { allowIncomplete: true }).conflicts[0]?.class,
    "TODO",
  );
});

it("keeps nightly proposer and reviewer separate in the record and ledger", () => {
  const proposer = {
    iface: "pi",
    provider: "meta",
    model: "muse-spark",
    session: "walk-1",
  };
  const reviewer = {
    iface: "pi",
    provider: "meta",
    model: "muse-spark",
    session: "review-2",
  };
  const nightlyReview = {
    status: "signed-off" as const,
    proposer,
    reviewer,
    reviewedAt: "2026-09-04T10:00:00.000Z",
    evidence: {
      target: "v1.0.0-nightly.20260904.1",
      targetSha: B,
      blockingSha: A,
      expectedOld: A,
      installedHead: B,
      ciHead: B,
      laneBranch: "rehearse/nightly",
      recordDigest: "d".repeat(64),
      inspected: NIGHTLY_REVIEW_EVIDENCE,
    },
  };
  const record = renderRecord({
    ...reportFixture(),
    target: { tag: "v1.0.0-nightly.20260904.1", sha: B },
    nightlyReview,
  });
  assert.deepStrictEqual(parseRecord(record).nightlyReview, nightlyReview);

  const [parsed] = parseLedger(
    JSON.stringify([
      {
        tag: "v1.0.0-nightly.20260904.1",
        before: A,
        after: B,
        recordUrl: "https://example.test/record",
        conflicts: [],
        decisions: [],
        censusFiles: [],
        nightlyReview,
      },
    ]),
  );
  assert.deepStrictEqual(parsed?.nightlyReview, nightlyReview);
  const section = renderChurnSection(parsed === undefined ? [] : [parsed]);
  assert.include(section, "agent `pi/meta/muse-spark` session `walk-1`");
  assert.include(section, "agent `pi/meta/muse-spark` session `review-2`");
  assert.notInclude(section, "| human | 1 |");
});

it("rejects incomplete or malformed nightly review ledger provenance", () => {
  const base = {
    tag: "v1.0.0-nightly.20260904.1",
    before: A,
    after: B,
    recordUrl: "https://example.test/record",
    conflicts: [],
    decisions: [],
    censusFiles: [],
  };
  const identity = {
    iface: "pi",
    provider: "meta",
    model: "muse-spark",
    session: "review-2",
  };
  const withheld = {
    status: "withheld",
    proposer: { ...identity, session: "walk-1" },
    reviewer: identity,
    reviewedAt: "2026-09-04T10:00:00.000Z",
    reason: "evidence cannot be verified",
  };
  assert.throws(
    () =>
      parseLedger(JSON.stringify([{ ...base, nightlyReview: { ...withheld, reason: undefined } }])),
    /withheld reason/,
  );
  assert.throws(
    () =>
      parseLedger(
        JSON.stringify([{ ...base, nightlyReview: { ...withheld, reviewedAt: "tomorrow" } }]),
      ),
    /reviewedAt/,
  );
  assert.throws(
    () =>
      parseLedger(
        JSON.stringify([
          {
            ...base,
            nightlyReview: {
              ...withheld,
              evidence: {
                target: base.tag,
                targetSha: B,
                blockingSha: A,
                expectedOld: A,
                installedHead: B,
                ciHead: B,
                laneBranch: "rehearse/nightly",
                recordDigest: "d".repeat(64),
                inspected: NIGHTLY_REVIEW_EVIDENCE,
              },
            },
          },
        ]),
      ),
    /withheld review has evidence/,
  );
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
    [
      {
        path: "apps/web/src/a|b.ts",
        hunks: 2,
        commit: "1234567",
        subject: "feat(web): change a | b",
        domain: "project-windows",
      },
    ],
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
      subject: "fix(web): retain route tests",
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

it("reads the generated census target tag", () => {
  assert.strictEqual(
    parseCensusTag(
      [
        "## Sequential rebase census",
        "",
        "A throwaway rebase rehearsal to `v0.0.39-nightly.20260902.1261` found 1 conflicting fork commit and 1 conflict-file resolution.",
      ].join("\n"),
    ),
    "v0.0.39-nightly.20260902.1261",
  );
});

const censusEntry = (tag: string, files: ChurnEntry["censusFiles"], after = B): ChurnEntry => ({
  tag,
  before: A,
  after,
  recordUrl: `https://example.test/${tag}`,
  conflicts: [],
  decisions: [],
  censusFiles: files,
});

/** A commit on the fixture trunk; `trailers` are appended message paragraphs. */
const trunkCommit = (
  root: string,
  parent: string | undefined,
  subject: string,
  paths: ReadonlyArray<string> = [],
  ...trailers: ReadonlyArray<string>
): string => {
  const blobOf = (path: string): string =>
    runCommandText("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: `${path}\n`,
    }).trim();
  // `git mktree` refuses slashes, so nesting is built one segment at a time.
  const treeOf = (entries: ReadonlyArray<string>): string =>
    runCommandText("git", ["mktree"], { cwd: root, input: entries.join("\n") }).trim();
  const buildTree = (prefix: string, remaining: ReadonlyArray<string>): string => {
    const deeper = /* @__PURE__ */ new Map<string, ReadonlyArray<string>>();
    const lines: Array<string> = [];
    for (const path of remaining) {
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) lines.push(`100644 blob ${blobOf(path)}\t${rest}`);
      else {
        const segment = rest.slice(0, slash);
        deeper.set(segment, [...(deeper.get(segment) ?? []), path]);
      }
    }
    for (const [segment, nested] of deeper)
      lines.push(`040000 tree ${buildTree(`${prefix}${segment}/`, nested)}\t${segment}`);
    return treeOf(lines);
  };
  const tree = buildTree("", paths);
  const args = [
    "commit-tree",
    tree,
    ...(parent === undefined ? [] : ["-p", parent]),
    "-m",
    subject,
  ];
  for (const trailer of trailers) args.push("-m", trailer);
  return runCommandText("git", args, { cwd: root }).trim();
};

it("reads a walk's repairs from the applied trunk range, never from the lane", () => {
  const root = repository();
  try {
    const base = trunkCommit(root, undefined, "feat(fork): base");
    const handRepair = trunkCommit(
      root,
      base,
      "chore(fork-sync): hand repair after the walk",
      [],
      "Fork-Domain: fork-meta",
      "Fork-Tier: bugfix",
      "Fork-Repair: v0.0.41-nightly.20260908.1414",
    );
    const untagged = trunkCommit(root, handRepair, "chore(fork): not a repair");
    const replayedRepair = trunkCommit(
      root,
      untagged,
      "chore(fork-sync): replay append",
      [],
      "Fork-Repair: v0.0.41-nightly.20260908.1414",
    );

    // Every returned SHA is reachable from the trunk the range sits on, and both the hand
    // repair and the replayed append are listed in walk order; untagged commits are not.
    assert.deepStrictEqual(trunkRepairCommits(root, base, replayedRepair), [
      { sha: handRepair, subject: "chore(fork-sync): hand repair after the walk" },
      { sha: replayedRepair, subject: "chore(fork-sync): replay append" },
    ]);
    assert.deepStrictEqual(trunkRepairCommits(root, base, base), []);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("yields no repair commits, without throwing, when the recorded range is unresolvable", () => {
  const root = repository();
  try {
    const base = trunkCommit(root, undefined, "feat(fork): base");
    // Placeholder SHAs a row may cite (a lane replay recorded elsewhere, a pruned commit) do not
    // abort the append: the row simply cites nothing (#700 keeps lane SHAs out either way).
    assert.deepStrictEqual(
      trunkRepairCommits(root, base, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      [],
    );
    assert.deepStrictEqual(
      trunkRepairCommits(root, "cccccccccccccccccccccccccccccccccccccccc", base),
      [],
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("pins the tooling-repair boundary to walk tooling alone", () => {
  // In: the harness itself and the fork's own internals pages.
  assert.isTrue(isToolingRepair(["scripts/fork-sync.ts"]));
  assert.isTrue(isToolingRepair(["scripts/lib/fork-additive.ts"]));
  assert.isTrue(isToolingRepair(["docs/internals/fork-budget.md"]));
  assert.isTrue(isToolingRepair(["scripts/a.ts", "docs/internals/fork-delta.md"]));
  // Out: anything a fork reader would call product, and lookalike paths.
  assert.isFalse(isToolingRepair([]));
  assert.isFalse(isToolingRepair(["apps/web/src/a.ts"]));
  assert.isFalse(isToolingRepair(["scriptsx/a.ts"]));
  assert.isFalse(isToolingRepair(["docs/internals/other.md"]));
  assert.isFalse(isToolingRepair(["docs/internals/fork-budget/nested.md"]));
  // A repair that also touches a product path is not a tooling repair.
  assert.isFalse(isToolingRepair(["scripts/a.ts", "apps/web/src/b.ts"]));
});

it("marks a repair that only touches walk tooling as tooling on the row", () => {
  const root = repository();
  try {
    const base = trunkCommit(root, undefined, "feat(fork): base");
    const tooling = trunkCommit(
      root,
      base,
      "chore(fork-sync): refresh rebinds the stack size",
      ["scripts/fork-sync.ts"],
      "Fork-Domain: fork-meta",
      "Fork-Tier: bugfix",
      "Fork-Repair: v0.0.41-nightly.20260908.1414",
    );
    const product = trunkCommit(
      root,
      tooling,
      "chore(web): repair a moved seam",
      ["apps/web/src/a.ts"],
      "Fork-Repair: v0.0.41-nightly.20260908.1414",
    );
    assert.deepStrictEqual(trunkRepairCommits(root, base, product), [
      {
        sha: tooling,
        subject: "chore(fork-sync): refresh rebinds the stack size",
        tooling: true,
      },
      { sha: product, subject: "chore(web): repair a moved seam" },
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("renders a walk's repairs, including tooling repairs, in the Walks table", () => {
  const root = ledgerRepository([
    {
      ...entry("v1", []),
      repairCommits: [
        { sha: "1f8c22dc68a", subject: "lane repair" },
        { sha: "d36809f6327", subject: "refresh rebinds the stack size", tooling: true },
      ],
    },
    entry("v0", []),
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
      .filter((line) => line.startsWith("| `v"));
    assert.include(walks[0] ?? "", "| 2 (1 tooling) | ");
    // A legacy row without repairs renders the column as absent, not as a guess.
    assert.include(walks[1] ?? "", "| — | ");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("parses the host handoff envelope once, schema and identity pinned", () => {
  const envelope = {
    schema: "ghb.host-handoff.v1",
    host: {
      role: "host",
      iface: "claude",
      provider: "anthropic",
      model: "claude-opus-5",
      effort: "high",
      harness: "claude-code@2.1.266",
      session: "walk-1",
    },
  };
  assert.deepStrictEqual(parseHostHandoff(JSON.stringify(envelope)), {
    iface: "claude",
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "high",
    session: "walk-1",
  });
  assert.throws(() => parseHostHandoff("not json"), /invalid ghb handoff JSON/);
  assert.throws(
    () => parseHostHandoff(JSON.stringify({ ...envelope, schema: "ghb.host-handoff.v2" })),
    /unsupported ghb handoff schema/,
  );
  assert.throws(
    () =>
      parseHostHandoff(
        JSON.stringify({ schema: envelope.schema, host: { ...envelope.host, role: "worker" } }),
      ),
    /invalid host role/,
  );
  assert.throws(
    () =>
      parseHostHandoff(
        JSON.stringify({ schema: envelope.schema, host: { ...envelope.host, effort: "" } }),
      ),
    /host handoff effort/,
  );
});

it("renders elapsed time and host effort on the Walks row, absent when unrecorded", () => {
  const root = ledgerRepository([
    {
      ...entry("v1", []),
      elapsedMs: 93_000,
      effort: { model: "claude-opus-5", effort: "high" },
    },
    entry("v0", []),
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
      .filter((line) => line.startsWith("| `v"));
    assert.include(walks[0] ?? "", "| 93s | claude-opus-5 (high) | ");
    // The pre-#703 rows keep parsing and keep rendering; absence stays absent.
    assert.include(walks[1] ?? "", "| — | — | ");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a malformed elapsed or effort field on a ledger row", () => {
  const base = {
    tag: "v1",
    before: A,
    after: B,
    recordUrl: "https://example.test/v1",
    conflicts: [],
    decisions: [],
    censusFiles: [],
  };
  assert.throws(() => parseLedger(JSON.stringify([{ ...base, elapsedMs: "soon" }])), /elapsedMs/);
  assert.throws(() => parseLedger(JSON.stringify([{ ...base, elapsedMs: -1 }])), /elapsedMs/);
  assert.throws(() => parseLedger(JSON.stringify([{ ...base, effort: { model: "m" } }])), /effort/);
});

it("writes the applied row when the host handoff is unavailable, effort rendered absent", () => {
  const root = ledgerRepository([]);
  const record = renderRecord(reportFixture());
  NodeFS.writeFileSync(NodePath.join(root, "record.md"), record);
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    "#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_GH_RESPONSE ?? '');\n",
    { mode: 0o755 },
  );
  // The attestation path is down: no ghb, an expired credential, a rate-limited daemon, CI.
  NodeFS.writeFileSync(NodePath.join(bin, "ghb"), "#!/bin/sh\necho refused >&2\nexit 1\n", {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  const previousResponse = process.env.FAKE_GH_RESPONSE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const trunkBase = trunkCommit(root, undefined, "feat(fork): base");
  const trunkHead = trunkCommit(root, trunkBase, "feat(fork): applied identity");
  process.env.FAKE_GH_RESPONSE = JSON.stringify({
    body: [
      "## Sequential rebase census",
      "",
      "A throwaway rebase rehearsal to `v1` found 0 conflicting fork commits.",
      "",
      "| File | Hunks | Fork commit | Domain |",
      "| --- | ---: | --- | --- |",
      "| `scripts/current.ts` | 1 | `1234567 feat(fork): current identity` | fork-meta |",
      "",
    ].join("\n"),
    comments: [{ body: record, url: "https://example.test/issues/1#issuecomment-1" }],
    url: "https://example.test/issues/1",
  });
  try {
    assert.strictEqual(
      run(
        [
          "append",
          "--record",
          "record.md",
          "--issue",
          "1",
          "--tag",
          "v1",
          "--before",
          trunkBase,
          "--after",
          trunkHead,
        ],
        root,
      ),
      0,
    );
    const appended = parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE)!)[0]!;
    assert.strictEqual(appended.tag, "v1");
    // The row is complete except for the decoration: no effort, and no elapsed time either,
    // because the fixture wrote no walk report beside the record.
    assert.strictEqual(appended.effort, undefined);
    assert.strictEqual(appended.elapsedMs, undefined);
    assert.strictEqual(appended.recordUrl, "https://example.test/issues/1#issuecomment-1");

    const internals = NodePath.join(root, "docs", "internals");
    NodeFS.writeFileSync(
      NodePath.join(internals, "fork-delta.md"),
      "## fork-meta\n\n### Retirement condition\n",
    );
    assert.strictEqual(run(["render"], root), 0);
    const walks = NodeFS.readFileSync(NodePath.join(internals, "fork-churn.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| `v1` |"));
    assert.include(walks ?? "", "| — | — | ");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousResponse === undefined) delete process.env.FAKE_GH_RESPONSE;
    else process.env.FAKE_GH_RESPONSE = previousResponse;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("finds the walk's elapsed time in the report bound to the record and this walk's tag", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-churn-elapsed-"));
  try {
    const recordPath = NodePath.join(root, "record.md");
    const writeReport = (name: string, body: object): void =>
      NodeFS.writeFileSync(NodePath.join(root, name), JSON.stringify(body));
    writeReport("unbound.json", {
      recordPath: `${root}\\elsewhere.md`,
      target: { tag: "v1" },
      walk: { elapsedMs: 1 },
    });
    // A record path is reused across walks: a stale report from an earlier walk against the
    // same record is another walk's number, never this row's.
    writeReport("older.json", { recordPath, target: { tag: "v0" }, walk: { elapsedMs: 5_000 } });
    assert.strictEqual(walkElapsedMs(recordPath, "v1"), undefined);
    // A tag-matching report without a numeric elapsed time never contributes a guess.
    writeReport("bad.json", { recordPath, target: { tag: "v1" }, walk: { elapsedMs: "soon" } });
    assert.strictEqual(walkElapsedMs(recordPath, "v1"), undefined);
    writeReport("matched.json", {
      recordPath,
      target: { tag: "v1" },
      walk: { elapsedMs: 93_000 },
    });
    assert.strictEqual(walkElapsedMs(recordPath, "v1"), 93_000);
    assert.strictEqual(walkElapsedMs(NodePath.join(root, "absent.md"), "v1"), undefined);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const censusFile = (path: string, commit: string, subject: string) => ({
  path,
  hunks: 1,
  commit,
  subject,
  domain: "fork-meta",
});

it("replays the historical census range and finds the current hot path from generated evidence", () => {
  const tags = [
    "v0.0.38-nightly.20260831.1236",
    "v0.0.38-nightly.20260831.1241",
    "v0.0.38-nightly.20260901.1242",
    "v0.0.38-nightly.20260901.1243",
    "v0.0.38-nightly.20260901.1244",
    "v0.0.38-nightly.20260901.1245",
    "v0.0.38-nightly.20260901.1246",
    "v0.0.39-nightly.20260902.1261",
  ];
  const hotPath = "apps/server/src/provider/Drivers/ClaudeDriver.ts";
  const entries = tags.map((tag, index) =>
    censusEntry(tag, [
      censusFile(
        hotPath,
        String(index + 1).repeat(7),
        index === tags.length - 1
          ? "fix(provider): resolve repo skills per workspace (#188)"
          : "fix(server): provider spawns drop another harness identity (#108)",
      ),
      ...(index === tags.length - 1
        ? []
        : [
            censusFile(
              "apps/desktop/src/preload.ts",
              `a${String(index).repeat(6)}`,
              "fix(desktop): isolate previews",
            ),
          ]),
    ]),
  );

  const churn = censusChurn(entries);
  assert.deepStrictEqual(churn.hotPaths, [
    {
      path: hotPath,
      consecutiveTags: 8,
      firstTag: "v0.0.38-nightly.20260831.1236",
      lastTag: "v0.0.39-nightly.20260902.1261",
    },
  ]);
  assert.deepStrictEqual(churn.regressions, []);
  assert.isTrue(entries.every((value) => value.conflicts.length === 0));
});

it("fails a path and logical commit seam that returns after a census gap", () => {
  const path = "apps/web/src/regressed.ts";
  const subject = "feat(web): keep the seam";
  const fixedAt = "f".repeat(40);
  const entries = [
    censusEntry("v1", [censusFile(path, "1111111", subject)], fixedAt),
    censusEntry("v2", [censusFile("other.ts", "2222222", "feat: other")]),
  ];
  const churn = censusChurn(entries, {
    tag: "v3",
    fixedAt: null,
    files: [censusFile(path, "3333333", subject)],
  });

  assert.deepStrictEqual(churn.regressions, []);
  assert.deepStrictEqual(regressedSeamLines(churn), []);
  assert.strictEqual(churn.seams.find((seam) => seam.path === path)?.status, "returned-unresolved");
  assert.isTrue(churn.seams.find((seam) => seam.path === path)?.blocking);
  assert.isNull(churn.seams.find((seam) => seam.path === path)?.repairSha);
  assert.include(
    renderChurnSection(entries, null, {
      tag: "v3",
      fixedAt: null,
      files: [censusFile(path, "3333333", subject)],
    }),
    "returned-unresolved",
  );
});

it("keeps a returned seam failed until comparable repair verification exists", () => {
  const path = "apps/web/src/regressed.ts";
  const subject = "feat(web): keep the seam";
  const entries = [
    censusEntry("v1", [censusFile(path, "1111111", subject)]),
    censusEntry("v2", [censusFile("other.ts", "2222222", "feat: other")]),
    censusEntry("v3", [censusFile(path, "3333333", subject)]),
  ];

  const returned = censusChurn(entries, {
    tag: "v4",
    fixedAt: null,
    files: [censusFile(path, "4444444", subject)],
  });
  assert.isTrue(returned.seams.find((seam) => seam.path === path)?.blocking);
  assert.deepStrictEqual(returned.regressions, []);
  const absent = censusChurn(entries, {
    tag: "v4",
    fixedAt: null,
    files: [censusFile("latest.ts", "4444444", "feat: latest")],
  });
  assert.deepStrictEqual(absent.regressions, []);
  assert.isTrue(absent.seams.find((seam) => seam.path === path)?.blocking);
  assert.strictEqual(absent.seams.find((seam) => seam.path === path)?.status, "not-observed");
});

it("keeps equal subjects in separate domain and path seams", () => {
  const subject = "feat: shared wording";
  const entries = [
    censusEntry("v1", [
      censusFile("a.ts", "1111111", subject),
      { ...censusFile("b.ts", "2222222", subject), domain: "project-windows" },
    ]),
    censusEntry("v2", [censusFile("other.ts", "3333333", "feat: other")]),
  ];

  assert.deepStrictEqual(
    censusChurn(entries, {
      tag: "v3",
      fixedAt: null,
      files: [{ ...censusFile("b.ts", "4444444", subject), domain: "project-windows" }],
    })
      .seams.filter((seam) => seam.blocking)
      .map(({ path, domain }) => ({ path, domain })),
    [{ path: "b.ts", domain: "project-windows" }],
  );
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

it("renders the notification KPIs from walk, seam, outcome, and delta inputs", () => {
  const repeat = conflict("repeat.ts", "human");
  const entries = [
    { ...entry("v1", [repeat]), elapsedMs: 10_000, effort: { model: "model-a", effort: "low" } },
    {
      ...entry("v2", [repeat, { ...conflict("agent.ts", "generated"), decidedBy: "agent" }]),
      elapsedMs: 20_000,
    },
  ];
  const records = ["v0", "v1", "v2"].map((tag) =>
    seamRecord(
      freezeObservation({
        tag,
        fixedAt: null,
        files: [censusFile("repeat.ts", "abcdef1", "feat: repeat")],
      }),
    ),
  );
  const section = renderChurnSection(entries, null, null, records, [], {
    commits: 12,
    overBudget: ["fork-meta"],
  });
  assert.include(section, "| decisions human : agent | 1 : 1 |");
  assert.include(section, "| conflict files, this walk vs last | 2 vs 1 |");
  assert.include(section, "| delta commits, and any domain over budget | 12; fork-meta |");
  assert.include(
    section,
    "| repeat offenders (commits conflicting in 3+ notifications) | `abcdef1` |",
  );
  assert.include(section, "| noAgentCarry streak / 5 | 0 / 5 |");
  assert.include(section, "| elapsed and effort | 20s; unrecorded |");
});

it("renders KPI fallbacks for a first walk", () => {
  const section = renderChurnSection([entry("v1", [])]);
  assert.include(section, "| conflict files, this walk vs last | 0 vs first walk |");
  assert.include(section, "| delta commits, and any domain over budget | unrecorded |");
  assert.include(section, "| elapsed and effort | unrecorded; unrecorded |");
  assert.include(renderMarkdown([entry("v1", [])], ""), "## KPIs");
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

it("migrates every legacy census subject once and survives expired objects", () => {
  const root = repository();
  runCommandText("git", ["remote", "add", "origin", root], { cwd: root });
  const tree = runCommandText("git", ["mktree"], { cwd: root, input: "" }).trim();
  const commits = [
    runCommandText("git", ["commit-tree", tree, "-m", "feat(fork): first identity"], {
      cwd: root,
    }).trim(),
    runCommandText("git", ["commit-tree", tree, "-m", "fix(fork): second identity"], {
      cwd: root,
    }).trim(),
  ];
  const legacy = censusEntry(
    "v0",
    commits.map((commit, index) => ({
      path: `scripts/legacy-${index}.ts`,
      hunks: 1,
      commit: commit.slice(0, 12),
      domain: "fork-meta",
    })),
  );
  writeBotRefFile(
    root,
    CHURN_REF,
    CHURN_LEDGER_FILE,
    `${JSON.stringify([legacy], null, 2)}\n`,
    "churn: legacy fixture",
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "docs", "internals", "fork-delta.md"),
    "## fork-meta\n\n### Retirement condition\n",
  );
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    "#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_GH_RESPONSE ?? '');\n",
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousResponse = process.env.FAKE_GH_RESPONSE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_GH_RESPONSE = JSON.stringify({
    body: [
      "## Sequential rebase census",
      "",
      "A throwaway rebase rehearsal to `v0` found 1 conflicting fork commit and 1 conflict-file resolution.",
      "",
      "| File | Hunks | Fork commit | Domain |",
      "| --- | ---: | --- | --- |",
      "| `scripts/current.ts` | 1 | `1234567 feat(fork): current identity` | fork-meta |",
    ].join("\n"),
    comments: [],
  });
  try {
    const before = runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim();
    assert.strictEqual(run(["migrate-subjects"], root), 0);
    const migrated = runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim();
    assert.notStrictEqual(migrated, before);
    assert.deepStrictEqual(
      parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE) ?? "")[0]?.censusFiles.map(
        ({ subject }) => subject,
      ),
      ["feat(fork): first identity", "fix(fork): second identity"],
    );

    assert.strictEqual(run(["migrate-subjects"], root), 0);
    assert.strictEqual(
      runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim(),
      migrated,
    );

    runCommandText("git", ["prune", "--expire=now"], { cwd: root });
    for (const commit of commits)
      assert.throws(() =>
        runCommandText("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root }),
      );
    assert.strictEqual(run(["render"], root), 0);
    assert.strictEqual(run(["report", "--issue", "1"], root), 0);
    assert.strictEqual(
      runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim(),
      migrated,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousResponse === undefined) delete process.env.FAKE_GH_RESPONSE;
    else process.env.FAKE_GH_RESPONSE = previousResponse;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("names every unresolved census commit without moving the ledger ref", () => {
  const unresolved = ["1111111", "2222222"];
  const root = ledgerRepository([
    censusEntry(
      "v0",
      unresolved.map((commit) => ({
        path: `${commit}.ts`,
        hunks: 1,
        commit,
        domain: "fork-meta",
      })),
    ),
  ]);
  const before = runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim();
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.strictEqual(run(["migrate-subjects"], root), 1);
    assert.include(stderr, `unresolved census commits: ${unresolved.join(", ")}`);
    assert.strictEqual(
      runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim(),
      before,
    );
  } finally {
    process.stderr.write = originalWrite;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("migrates against the advertised head and refuses a diverged local ledger", () => {
  const root = repository();
  const remote = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-churn-remote-"));
  runCommandText("git", ["init", "--quiet", "--bare", remote], { cwd: root });
  runCommandText("git", ["remote", "add", "origin", remote], { cwd: root });
  const tree = runCommandText("git", ["mktree"], { cwd: root, input: "" }).trim();
  const legacyCommit = runCommandText(
    "git",
    ["commit-tree", tree, "-m", "feat(fork): leased identity"],
    { cwd: root },
  ).trim();
  writeBotRefFile(
    root,
    CHURN_REF,
    CHURN_LEDGER_FILE,
    `${JSON.stringify([
      censusEntry("v0", [
        {
          path: "scripts/legacy.ts",
          hunks: 1,
          commit: legacyCommit.slice(0, 12),
          domain: "fork-meta",
        },
      ]),
    ])}\n`,
    "churn: legacy fixture",
  );
  runCommandText("git", ["push", "--quiet", "origin", `${CHURN_REF}:${CHURN_REF}`], {
    cwd: root,
  });
  const expectedOld = runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim();
  const ledgerTree = runCommandText("git", ["rev-parse", `${CHURN_REF}^{tree}`], {
    cwd: root,
  }).trim();
  // A concurrent writer publishes a walk this checkout has never seen.
  const rivalLedger = `${JSON.stringify([
    ...parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE) ?? ""),
    censusEntry("v1", []),
  ])}\n`;
  const rivalBlob = runCommandText("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: rivalLedger,
  }).trim();
  const rivalTree = runCommandText("git", ["mktree"], {
    cwd: root,
    input: `100644 blob ${rivalBlob}\t${CHURN_LEDGER_FILE}\n`,
  }).trim();
  const rival = runCommandText(
    "git",
    ["commit-tree", rivalTree, "-p", expectedOld, "-m", "churn: rival writer"],
    { cwd: root },
  ).trim();
  runCommandText("git", ["push", "--quiet", "origin", `${rival}:${CHURN_REF}`], { cwd: root });
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    // The stale checkout refreshes onto the published walk and publishes on a normal run.
    assert.strictEqual(run(["migrate-subjects", "--push"], root), 0);
    const migrated = runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim();
    assert.strictEqual(
      runCommandText("git", ["rev-parse", `${CHURN_REF}~1`], { cwd: root }).trim(),
      rival,
    );
    assert.strictEqual(
      runCommandText("git", ["ls-remote", remote, CHURN_REF], { cwd: root }).split("\t")[0],
      migrated,
    );
    const entries = parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE) ?? "");
    assert.deepStrictEqual(
      entries.map((entry) => entry.tag),
      ["v0", "v1"],
    );
    assert.isTrue(
      entries.every((entry) => entry.censusFiles.every((file) => file.subject !== undefined)),
    );

    // A local ledger that is neither behind nor ahead of origin fails closed on all three SHAs.
    const sibling = runCommandText(
      "git",
      ["commit-tree", ledgerTree, "-p", expectedOld, "-m", "churn: sibling"],
      { cwd: root },
    ).trim();
    runCommandText("git", ["update-ref", CHURN_REF, sibling, migrated], { cwd: root });
    assert.strictEqual(run(["migrate-subjects", "--push"], root), 1);
    assert.include(
      stderr,
      `local=${sibling}, remote=${migrated}, expected=${migrated}; neither ref was overwritten`,
    );
    assert.strictEqual(
      runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim(),
      sibling,
    );
    assert.strictEqual(
      runCommandText("git", ["ls-remote", remote, CHURN_REF], { cwd: root }).split("\t")[0],
      migrated,
    );
  } finally {
    process.stderr.write = originalWrite;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(remote, { recursive: true, force: true });
  }
});

it("renders the frozen mirror before mutating the churn ref", () => {
  const root = ledgerRepository([censusEntry("v1", [])]);
  const before = readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE);
  const record = renderRecord(reportFixture());
  NodeFS.writeFileSync(NodePath.join(root, "record.md"), record);
  NodeFS.writeFileSync(NodePath.join(root, DOCUMENT_PATH), "stale\n");
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    "#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_GH_RESPONSE ?? '');\n",
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousResponse = process.env.FAKE_GH_RESPONSE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_GH_RESPONSE = JSON.stringify({
    body: [
      "## Sequential rebase census",
      "",
      "A throwaway rebase rehearsal to `v2` found 1 conflicting fork commit and 1 conflict-file resolution.",
      "",
      "| File | Hunks | Fork commit | Domain |",
      "| --- | ---: | --- | --- |",
      "| `scripts/current.ts` | 1 | `3333333 fix(fork): current` | fork-meta |",
    ].join("\n"),
    comments: [{ body: record, url: "https://example.test/issues/1#issuecomment-1" }],
    url: "https://example.test/issues/1",
  });
  try {
    assert.strictEqual(
      run(
        [
          "append",
          "--record",
          "record.md",
          "--issue",
          "1",
          "--tag",
          "v2",
          "--before",
          A,
          "--after",
          B,
        ],
        root,
      ),
      1,
    );
    assert.strictEqual(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE), before);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousResponse === undefined) delete process.env.FAKE_GH_RESPONSE;
    else process.env.FAKE_GH_RESPONSE = previousResponse;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a mismatched census tag before mutation and accepts the matching identity", () => {
  const root = ledgerRepository([]);
  const record = renderRecord(reportFixture());
  NodeFS.writeFileSync(NodePath.join(root, "record.md"), record);
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    "#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_GH_RESPONSE ?? '');\n",
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousResponse = process.env.FAKE_GH_RESPONSE;
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  const evidence = {
    version: 1,
    method: "sequential-rebase-stage3-provisional",
    sourceSha: A,
    baseSha: A,
    targetSha: B,
    targetTag: "v2",
    complete: true,
    rows: [],
  } as const;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_GH_RESPONSE = JSON.stringify({
    body: `## Sequential rebase census\n<!-- sequential-census-v1:${JSON.stringify(evidence)} -->`,
    comments: [{ body: record, url: "https://example.test/issues/1#issuecomment-1" }],
    url: "https://example.test/issues/1",
  });
  try {
    // The applied row cites the applied trunk range, so the fixture needs real trunk commits.
    const trunkBase = trunkCommit(root, undefined, "feat(fork): base");
    const trunkHead = trunkCommit(root, trunkBase, "feat(fork): applied identity");
    const before = runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim();
    const append = (tag: string) =>
      run(
        [
          "append",
          "--record",
          "record.md",
          "--issue",
          "1",
          "--tag",
          tag,
          "--before",
          trunkBase,
          "--after",
          trunkHead,
        ],
        root,
      );
    // The block issue's census is live: the sync bot refreshes it as soon as a newer upstream tag
    // lands, which happens while a walk is still replaying the tag it selected. That census is not
    // evidence for this row, but the walk still landed, so the row is written without it.
    assert.strictEqual(append("v2-alias"), 0, stderr);
    assert.include(stderr, "census on issue 1 is for v2, not v2-alias");
    const aliased = parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE)!)[0]!;
    assert.strictEqual(aliased.tag, "v2-alias");
    assert.isUndefined(aliased.censusEvidence);
    assert.notStrictEqual(
      runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim(),
      before,
    );
    assert.strictEqual(append("v2"), 0, stderr);
    const appended = parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE)!).find(
      (row) => row.tag === "v2",
    )!;
    assert.strictEqual(appended.tag, "v2");
    assert.deepStrictEqual(appended.censusEvidence, evidence);
  } finally {
    process.stderr.write = originalWrite;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousResponse === undefined) delete process.env.FAKE_GH_RESPONSE;
    else process.env.FAKE_GH_RESPONSE = previousResponse;
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

/** The artifact `fork:auto-rebase` retains, trimmed to what the producer reads. */
const stopCensusFixture = (sourceSha: string, paths: ReadonlyArray<string>, complete = true) => ({
  targetTag: "v1.0.0",
  evidence: {
    version: 1,
    method: "sequential-rebase-stage3-provisional",
    sourceSha,
    baseSha: "d".repeat(40),
    targetSha: "c".repeat(40),
    targetTag: "v1.0.0",
    complete,
    rows: paths.map((path, index) => ({
      stop: index + 1,
      commit: A,
      subject: "feat: preserve fork intent",
      domain: "fork-meta",
      path,
      kind: "content",
    })),
  },
  conflictingForkCommitCount: paths.length === 0 ? 0 : 1,
  conflictingFileCount: paths.length,
  truncated: !complete,
  truncatedBy: complete ? null : "stop-limit",
  stopLimit: 40,
  timeLimitSeconds: 900,
});

it("composes evidence-bearing seam records that the single import path accepts", () => {
  const root = ledgerRepository([]);
  try {
    const write = (name: string, value: unknown): string => {
      NodeFS.writeFileSync(NodePath.join(root, name), JSON.stringify(value));
      return name;
    };
    write("before.json", stopCensusFixture(A, ["seam.ts"]));
    write("after.json", stopCensusFixture(B, []));
    write("truncated.json", stopCensusFixture(B, [], false));
    const plan = (after: string) => ({
      version: 1,
      observations: [
        { alias: "before", census: "before.json" },
        { alias: "after", census: after },
      ],
      repairs: [
        {
          alias: "seam",
          before: { observation: "before", path: "seam.ts" },
          changeSha: B,
          guard: "vp test run seam.fork.test.ts",
          attestation: {
            actor: "maintainer-agent",
            evidenceUrl: "https://example.test/review/1",
          },
        },
      ],
      verifications: [
        {
          repair: "seam",
          after: "after",
          guardProof: {
            sourceSha: B,
            command: "vp test run seam.fork.test.ts",
            exitCode: 0,
            output: "1 passed",
          },
          attestation: {
            actor: "maintainer-agent",
            evidenceUrl: "https://example.test/review/1",
          },
        },
      ],
    });
    write("plan.json", plan("after.json"));
    assert.strictEqual(run(["compose", "--plan", "plan.json"], root), 2);
    assert.strictEqual(run(["compose", "--plan", "plan.json", "--at", "x"], root), 2);
    assert.strictEqual(run(["compose", "--plan", "plan.json", "--out", "bundle.json"], root), 0);
    // Composing never writes the ledger; the reviewed bundle still goes through record --input.
    assert.deepStrictEqual(readChurnState(root).seamRecords, []);
    assert.strictEqual(run(["record", "--input", "bundle.json"], root), 0);
    const recorded = readChurnState(root).seamRecords;
    assert.strictEqual(recorded.length, 4);
    const observation = recorded.flatMap((record) =>
      record.kind === "observation" ? [record] : [],
    )[0];
    assert.strictEqual(observation?.evidence?.sourceSha, A);
    // A pass measured against a truncated census cannot prove the repair, so it never reaches disk.
    write("bad.json", plan("truncated.json"));
    assert.strictEqual(run(["compose", "--plan", "bad.json", "--out", "bad-bundle.json"], root), 1);
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, "bad-bundle.json")));
    assert.deepStrictEqual(readChurnState(root).seamRecords, recorded);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
