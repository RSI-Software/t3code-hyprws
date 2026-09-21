// @effect-diagnostics nodeBuiltinImport:off - Temporary ledger fixtures use Node helpers.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  censusChurn,
  hotSeams,
  parseCensusFiles,
  parseCensusTag,
  parseLedger,
  run,
  trunkRepairCommits,
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
import { autoOutcomeReceipts } from "./fork-churn-outcomes.ts";
import { requireOutcomeReceipts, summarizeOutcomes } from "./lib/fork-sync-outcomes.ts";
import type { AutoRebaseResult } from "./fork-auto-rebase.ts";
import { isToolingRepair } from "./lib/fork-repairs.ts";
import { freezeObservation, seamRecord } from "./lib/fork-churn-seams.ts";
import { parseCallerAttestation } from "./lib/fork-agent-identity.ts";
import {
  NIGHTLY_REVIEW_EVIDENCE,
  recordDecisionRows,
  renderRecord,
  type SyncReport,
} from "./fork-sync-state.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

const reportFixture = (): SyncReport => ({
  schemaVersion: 2,
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

/**
 * The typed report `append` reads. The record is a projection now, so the row's every value comes
 * from this file (RSI-Software/t3code-hyprws#1144).
 */
const writeReportFixture = (root: string, overrides: Partial<SyncReport> = {}): void => {
  const reportPath = NodePath.join(root, "report.json");
  NodeFS.writeFileSync(
    reportPath,
    JSON.stringify({
      ...reportFixture(),
      repositoryRoot: root,
      reportPath,
      recordPath: NodePath.join(root, "record.md"),
      ...overrides,
    }),
  );
};

it("projects the report's own decisions into the ledger without reading the record", () => {
  assert.deepStrictEqual(recordDecisionRows(reportFixture()), reportFixture().orientationDecisions);
});

/** The record is a projection: rewriting the comment cannot change what the ledger stores. */
it("ignores an edited record when it projects the decisions", () => {
  const report = reportFixture();
  const edited = renderRecord(report)
    .replace(/partial/g, "retire")
    .replace(/human/g, "agent");
  assert.notStrictEqual(edited, renderRecord(report));
  assert.deepStrictEqual(recordDecisionRows(report), report.orientationDecisions);
});

it("keeps nightly proposer and reviewer separate in the ledger", () => {
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

it("reads a ledger row written before provenance as deciding nothing", () => {
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
  assert.isTrue(isToolingRepair(["docs/fork/internals/fork-development.md"]));
  assert.isTrue(isToolingRepair(["scripts/a.ts", "docs/fork/internals/fork-delta.md"]));
  // Out: anything a fork reader would call product, and lookalike paths.
  assert.isFalse(isToolingRepair([]));
  assert.isFalse(isToolingRepair(["apps/web/src/a.ts"]));
  assert.isFalse(isToolingRepair(["scriptsx/a.ts"]));
  assert.isFalse(isToolingRepair(["docs/internals/other.md"]));
  assert.isFalse(isToolingRepair(["docs/internals/fork-development/nested.md"]));
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

it("parses the caller attestation once, schema and both identities pinned", () => {
  const worker = {
    role: "worker",
    iface: "claude",
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "high",
    harness: "claude-code@2.1.266",
    session: "reviewer-1",
  };
  const host = { ...worker, role: "host", session: "walk-1" };
  const envelope = { schema: "ghb.caller.v1", caller: worker, host };
  // A handed-off worker answers with itself as the caller and with the host it carries, so a
  // sign-off and a walk attestation can read the same envelope and get different agents.
  const handedOff = parseCallerAttestation(JSON.stringify(envelope));
  assert.strictEqual(handedOff.caller.session, "reviewer-1");
  assert.strictEqual(handedOff.caller.role, "worker");
  assert.strictEqual(handedOff.host?.session, "walk-1");
  // A host caller carries no separate host block and is its own host.
  const direct = parseCallerAttestation(JSON.stringify({ schema: "ghb.caller.v1", caller: host }));
  assert.strictEqual(direct.host, null);
  assert.strictEqual(direct.caller.session, "walk-1");
  assert.throws(() => parseCallerAttestation("not json"), /invalid ghb caller JSON/);
  assert.throws(
    () => parseCallerAttestation(JSON.stringify({ ...envelope, schema: "ghb.caller.v2" })),
    /unsupported ghb caller schema/,
  );
  // A worker with no host block has no host identity to offer; absence is not a promotion.
  assert.throws(
    () => parseCallerAttestation(JSON.stringify({ schema: "ghb.caller.v1", caller: worker })),
    /names no host and the caller is not one/,
  );
  assert.throws(
    () =>
      parseCallerAttestation(JSON.stringify({ ...envelope, host: { ...host, role: "worker" } })),
    /invalid host role/,
  );
  assert.throws(
    () => parseCallerAttestation(JSON.stringify({ ...envelope, host: { ...host, effort: "" } })),
    /caller attestation host effort/,
  );
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

it("writes the applied row bound to the record comment the report names", () => {
  const root = ledgerRepository([]);
  const record = renderRecord(reportFixture());
  NodeFS.writeFileSync(NodePath.join(root, "record.md"), record);
  writeReportFixture(root, {
    recordCommentUrl: "https://example.test/issues/1#issuecomment-1",
  });
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
          "--report",
          "report.json",
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
    assert.strictEqual(appended.recordUrl, "https://example.test/issues/1#issuecomment-1");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousResponse === undefined) delete process.env.FAKE_GH_RESPONSE;
    else process.env.FAKE_GH_RESPONSE = previousResponse;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

/** The fake gh a pending append needs: the record lookup answered. */
const stubGh = (root: string, recordPath: string): { restore: () => void } => {
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    '#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_GH_RESPONSE ?? "");\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousResponse = process.env.FAKE_GH_RESPONSE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
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
    comments: [
      {
        body: NodeFS.readFileSync(recordPath, "utf8"),
        url: "https://example.test/issues/1#issuecomment-1",
      },
    ],
    url: "https://example.test/issues/1",
  });
  return {
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousResponse === undefined) delete process.env.FAKE_GH_RESPONSE;
      else process.env.FAKE_GH_RESPONSE = previousResponse;
    },
  };
};

it("a pending append without a posted record binds the issue and the rewrite upgrades it (#1057)", () => {
  const root = ledgerRepository([]);
  const recordPath = NodePath.join(root, "record.md");
  NodeFS.writeFileSync(recordPath, renderRecord(reportFixture()));
  writeReportFixture(root);
  const stub = stubGh(root, recordPath);
  // The stop path: nothing verbatim on the issue, so the verbatim match fails — the
  // pending row still lands, bound to the block issue itself.
  const censusBody = [
    "## Sequential rebase census",
    "",
    "A throwaway rebase rehearsal to `v1` found 0 conflicting fork commits.",
    "",
    "| File | Hunks | Fork commit | Domain |",
    "| --- | ---: | --- | --- |",
    "| `scripts/current.ts` | 1 | `1234567 feat(fork): current identity` | fork-meta |",
    "",
  ].join("\n");
  process.env.FAKE_GH_RESPONSE = JSON.stringify({
    body: censusBody,
    comments: [],
    url: "https://example.test/issues/1",
  });
  const args = [
    "append",
    "--report",
    "report.json",
    "--issue",
    "1",
    "--tag",
    "v1",
    "--before",
    A,
    "--after",
    B,
    "--pending",
  ];
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.strictEqual(run(args, root), 0, stderr);
    assert.strictEqual(
      parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE)!)[0]?.recordUrl,
      "https://example.test/issues/1",
    );
    // `record-decisions` posts the record and persists the comment URL on the report, so the
    // same rewrite upgrades the binding to the posted comment.
    writeReportFixture(root, {
      recordCommentUrl: "https://example.test/issues/1#issuecomment-2",
    });
    process.env.FAKE_GH_RESPONSE = JSON.stringify({
      body: censusBody,
      comments: [
        {
          body: NodeFS.readFileSync(recordPath, "utf8"),
          url: "https://example.test/issues/1#issuecomment-2",
        },
      ],
      url: "https://example.test/issues/1",
    });
    assert.strictEqual(run(args, root), 0);
    const rewritten = parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE)!);
    assert.strictEqual(rewritten.length, 1);
    assert.strictEqual(rewritten[0]?.recordUrl, "https://example.test/issues/1#issuecomment-2");
    assert.strictEqual(rewritten[0]?.pending, true);
  } finally {
    stub.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("an applied append without a posted record still refuses the write (#1057)", () => {
  const root = ledgerRepository([]);
  const recordPath = NodePath.join(root, "record.md");
  NodeFS.writeFileSync(recordPath, renderRecord(reportFixture()));
  writeReportFixture(root);
  const stub = stubGh(root, recordPath);
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
    comments: [],
    url: "https://example.test/issues/1",
  });
  const trunkBase = trunkCommit(root, undefined, "feat(fork): base");
  const trunkHead = trunkCommit(root, trunkBase, "feat(fork): applied identity");
  try {
    assert.strictEqual(
      run(
        [
          "append",
          "--report",
          "report.json",
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
      1,
    );
    assert.deepStrictEqual(parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE)!), []);
  } finally {
    stub.restore();
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
  assert.strictEqual(churn.seams.find((seam) => seam.path === path)?.status, "returned-unresolved");
  assert.isTrue(churn.seams.find((seam) => seam.path === path)?.blocking);
  assert.isNull(churn.seams.find((seam) => seam.path === path)?.repairSha);
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

it("counts a path only ever seen on stopped walks as a hot seam", () => {
  const seams = hotSeams([
    { ...entry("v1", [conflict("stopped-seam.ts", "human")]), pending: true as const },
    { ...entry("v2", [conflict("stopped-seam.ts", "human")]), pending: true as const },
  ]);
  assert.strictEqual(seams.length, 1);
  assert.strictEqual(seams[0]?.path, "stopped-seam.ts");
  assert.strictEqual(seams[0]?.walkCount, 2);
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
  NodeFS.mkdirSync(NodePath.join(root, "docs", "fork", "internals"), { recursive: true });
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
  NodeFS.mkdirSync(NodePath.join(root, "docs", "internals"), { recursive: true });
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
    NodePath.join(root, "docs", "fork", "internals", "fork-delta.md"),
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
    assert.strictEqual(run(["report"], root), 0);
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

it("refuses a mismatched census tag before mutation and accepts the matching identity", () => {
  const root = ledgerRepository([]);
  const record = renderRecord(reportFixture());
  NodeFS.writeFileSync(NodePath.join(root, "record.md"), record);
  writeReportFixture(root, {
    recordCommentUrl: "https://example.test/issues/1#issuecomment-1",
  });
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
          "--report",
          "report.json",
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
          "--report",
          "missing.json",
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
    assert.strictEqual(run(["report"], root), 1);
    assert.match(stderr, /refs\/fork\/churn lesson evidence is unavailable/);
  } finally {
    process.stderr.write = originalWrite;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

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

it("report keeps a failing policy verdict with zero GitHub transport and no publication", () => {
  const path = "apps/web/src/regressed.ts";
  const subject = "feat(web): keep the seam";
  // The landed censuses carry a seam that returned without comparable repair
  // verification, so the lesson policy FAILS.
  const root = ledgerRepository([
    censusEntry("v1", [censusFile(path, "1111111", subject)]),
    censusEntry("v2", [censusFile("other.ts", "2222222", "feat: other")]),
    censusEntry("v3", [censusFile(path, "3333333", subject)]),
  ]);
  // Freshness must be current, so an isolated origin advertises the same ref sha.
  const origin = NodePath.join(root, "origin.git");
  runCommandText("git", ["init", "--quiet", "--bare", origin], { cwd: root });
  runCommandText("git", ["push", "--quiet", origin, `${CHURN_REF}:${CHURN_REF}`], { cwd: root });
  runCommandText("git", ["remote", "add", "origin", origin], { cwd: root });

  // A transport that records every gh invocation the verb attempts; the report,
  // which publishes nothing, must attempt none - no POST, no read, no gh at all.
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  const calls = NodePath.join(root, "gh-calls.log");
  NodeFS.writeFileSync(calls, "");
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.SEAM_GH_CALLS, process.argv.slice(2).join(" ") + "\\n");\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousCalls = process.env.SEAM_GH_CALLS;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SEAM_GH_CALLS = calls;
  const receiptPath = NodePath.join(root, "report-receipt.json");
  try {
    // The recorder must prove it works before its silence means anything: a
    // deliberate invocation appends one line, and the log is reset afterwards.
    runCommandText("gh", ["control invocation"], { cwd: root });
    assert.strictEqual(NodeFS.readFileSync(calls, "utf8"), "control invocation\n");
    NodeFS.writeFileSync(calls, "");

    assert.strictEqual(run(["report", "--receipt", receiptPath], root), 0);
    assert.strictEqual(NodeFS.readFileSync(calls, "utf8"), "");
    // The verdict is failing - not skipped, not passed, not absent - and the
    // receipt carries publication not-attempted.
    const receipt = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")) as {
      publication: "not-attempted";
      policy: "failed" | "succeeded";
      reason?: "blocking-seams" | "lesson-unavailable";
    };
    assert.deepStrictEqual(receipt, {
      publication: "not-attempted",
      policy: "failed",
      reason: "blocking-seams",
    });

    // The outcome gate reads the same receipt: the retained stages keep the failed
    // policy verdict and record the never-attempted publication.
    const blockedSha = "9".repeat(40);
    const blockedTarget = {
      kind: "target",
      target: { tag: "v1.2.0", sha: blockedSha },
      eligible: true,
      reason: "selected tagged target under the fork tag policy",
    } as const;
    const blockedAttempt = {
      kind: "attempt",
      targetSha: blockedSha,
      attemptId: "42/1/rebase",
      sourceSha: "8".repeat(40),
      trigger: "push",
      executor: "bot",
      mode: "on",
      runUrl: "https://example.test/run/42",
    } as const;
    const result: AutoRebaseResult = {
      schemaVersion: 1,
      mode: "on",
      dryRun: false,
      status: "no-op",
      oldSha: "8".repeat(40),
      baseSha: "7".repeat(40),
      target: null,
      newSha: null,
      stableCandidates: [],
      verificationDependencySetup: [],
      decision: { pairwiseFirstConflict: null, census: null, censusUnavailableReason: null },
      blocked: { newestUpstreamTagBeyondWindow: "v1.2.0" } as AutoRebaseResult["blocked"],
    };
    const rows = autoOutcomeReceipts(
      requireOutcomeReceipts([blockedTarget, blockedAttempt]),
      result,
      receipt,
    );
    const stages = summarizeOutcomes(rows)[0]!.stages;
    assert.strictEqual(stages.find((row) => row.stage === "report-policy")?.status, "failed");
    assert.strictEqual(
      stages.find((row) => row.stage === "report-publication")?.status,
      "not-attempted",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCalls === undefined) delete process.env.SEAM_GH_CALLS;
    else process.env.SEAM_GH_CALLS = previousCalls;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("report assesses a live census from the auto-result artifact without carry or GitHub", () => {
  const path = "apps/web/src/regressed.ts";
  const subject = "feat(web): keep the seam";
  // Evidence rows carry full SHAs; identity is (path, subject, domain), so the
  // live row still matches the ledger's short-commit census file.
  const row = (pathName: string, commit: string) => ({
    stop: 1,
    commit,
    subject,
    domain: "fork-meta",
    path: pathName,
    kind: "content" as const,
    shape: "woven" as const,
  });
  // Real landed walks carry the census they measured, and the identity basis is
  // method+version, so the ledger's evidence must share the live census's method
  // for its recorded absence to count against the live recurrence.
  const evidence = (rows: ReadonlyArray<ReturnType<typeof row>>) => ({
    version: 2 as const,
    method: "sequential-rebase-walk-resolution" as const,
    sourceSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    targetSha: "c".repeat(40),
    targetTag: "v1.2.0",
    complete: true,
    rows,
  });
  // The landed history is previously clear: the seam appeared, then went absent.
  const root = ledgerRepository([
    {
      ...censusEntry("v1", [censusFile(path, "1111111", subject)]),
      censusEvidence: evidence([row(path, "1".repeat(40))]),
    },
    {
      ...censusEntry("v2", [censusFile("other.ts", "2222222", "feat: other")]),
      censusEvidence: evidence([row("other.ts", "2".repeat(40))]),
    },
  ]);
  const origin = NodePath.join(root, "origin.git");
  runCommandText("git", ["init", "--quiet", "--bare", origin], { cwd: root });
  runCommandText("git", ["push", "--quiet", origin, `${CHURN_REF}:${CHURN_REF}`], { cwd: root });
  runCommandText("git", ["remote", "add", "origin", origin], { cwd: root });

  // The blocked attempt's typed auto-result, exactly what the rebase job writes
  // with --issue-json: its census shows the seam recurring in the live walk.
  const liveEvidence = evidence([row(path, "1".repeat(40))]);
  const artifact = NodePath.join(root, "fork-auto-rebase-issues.json");
  NodeFS.writeFileSync(
    artifact,
    JSON.stringify({
      schemaVersion: 1,
      decision: {
        pairwiseFirstConflict: null,
        census: {
          targetTag: "v1.2.0",
          evidence: liveEvidence,
          conflictingForkCommitCount: 1,
          conflictingFileCount: 1,
          truncated: false,
          truncatedBy: null,
          stopLimit: 200,
          timeLimitSeconds: 600,
        },
        censusUnavailableReason: null,
      },
      blocked: { newestUpstreamTagBeyondWindow: "v1.2.0" },
    }),
  );

  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  const calls = NodePath.join(root, "gh-calls.log");
  NodeFS.writeFileSync(calls, "");
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.SEAM_GH_CALLS, process.argv.slice(2).join(" ") + "\\n");\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousCalls = process.env.SEAM_GH_CALLS;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SEAM_GH_CALLS = calls;
  const receiptPath = NodePath.join(root, "report-receipt.json");
  try {
    // Landed history alone reads clear, and the run says its assessment is
    // history-only instead of passing silently.
    assert.strictEqual(run(["report", "--receipt", receiptPath], root), 0);
    assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")), {
      publication: "not-attempted",
      policy: "succeeded",
    });

    // The same ledger plus the blocked attempt's recurring census is a live
    // returned-unresolved seam: the verdict fails even though carry never runs.
    assert.strictEqual(run(["report", "--receipt", receiptPath, "--census", artifact], root), 0);
    assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")), {
      publication: "not-attempted",
      policy: "failed",
      reason: "blocking-seams",
    });
    // Neither assessment touched GitHub: no read, no POST, no gh at all.
    assert.strictEqual(NodeFS.readFileSync(calls, "utf8"), "");

    // The outcome gate keeps the failing verdict from the live-census receipt.
    const blockedSha = "9".repeat(40);
    const blockedTarget = {
      kind: "target",
      target: { tag: "v1.2.0", sha: blockedSha },
      eligible: true,
      reason: "selected tagged target under the fork tag policy",
    } as const;
    const blockedAttempt = {
      kind: "attempt",
      targetSha: blockedSha,
      attemptId: "42/1/rebase",
      sourceSha: "8".repeat(40),
      trigger: "push",
      executor: "bot",
      mode: "on",
      runUrl: "https://example.test/run/42",
    } as const;
    const rows = autoOutcomeReceipts(
      requireOutcomeReceipts([blockedTarget, blockedAttempt]),
      {
        decision: { census: null, censusUnavailableReason: null },
        blocked: { newestUpstreamTagBeyondWindow: "v1.2.0" },
      } as AutoRebaseResult,
      JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")),
    );
    const stages = summarizeOutcomes(rows)[0]!.stages;
    assert.strictEqual(stages.find((row) => row.stage === "report-policy")?.status, "failed");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCalls === undefined) delete process.env.SEAM_GH_CALLS;
    else process.env.SEAM_GH_CALLS = previousCalls;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("report never passes on live census evidence it could not assess", () => {
  const path = "apps/web/src/regressed.ts";
  const subject = "feat(web): keep the seam";
  // One legacy ledger: the seam appeared (v1), then went absent (v2). The
  // absence is recorded under the legacy identity basis, so the feasibility
  // overlap fallback's recurrence is live blocking evidence, exactly what the
  // base block-issue path assessed (RSI-Software/t3code-hyprws#1142).
  const root = ledgerRepository([
    censusEntry("v1", [censusFile(path, "1111111", subject)]),
    censusEntry("v2", [censusFile("other.ts", "2222222", "feat: other")]),
  ]);
  const origin = NodePath.join(root, "origin.git");
  runCommandText("git", ["init", "--quiet", "--bare", origin], { cwd: root });
  runCommandText("git", ["push", "--quiet", origin, `${CHURN_REF}:${CHURN_REF}`], { cwd: root });
  runCommandText("git", ["remote", "add", "origin", origin], { cwd: root });

  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  const calls = NodePath.join(root, "gh-calls.log");
  NodeFS.writeFileSync(calls, "");
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.SEAM_GH_CALLS, process.argv.slice(2).join(" ") + "\\n");\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousCalls = process.env.SEAM_GH_CALLS;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SEAM_GH_CALLS = calls;
  const artifact = NodePath.join(root, "fork-auto-rebase-issues.json");
  const receiptPath = NodePath.join(root, "report-receipt.json");
  const runCensus = (): number =>
    run(["report", "--receipt", receiptPath, "--census", artifact], root);
  try {
    // Malformed envelope: not a recognizable auto result, so an error - the
    // pre-written receipt stays not-attempted, never a verdict.
    NodeFS.writeFileSync(artifact, JSON.stringify({}));
    assert.strictEqual(runCensus(), 1);
    assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")), {
      publication: "not-attempted",
      policy: "not-attempted",
    });

    // Provenance is validated by the shared census validator and the envelope
    // version is explicit: every refusal below is an error whose receipt stays
    // not-attempted, never a warning that history may upgrade to a pass.
    const validEvidence = {
      version: 2,
      method: "sequential-rebase-walk-resolution",
      sourceSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      targetSha: "c".repeat(40),
      targetTag: "v1.2.0",
      complete: true,
      rows: [],
    };
    const envelopeWith = (mutate: (envelope: Record<string, unknown>) => void): string => {
      const envelope: Record<string, unknown> = {
        schemaVersion: 1,
        decision: {
          pairwiseFirstConflict: null,
          census: {
            targetTag: "v1.2.0",
            evidence: JSON.parse(JSON.stringify(validEvidence)),
            conflictingForkCommitCount: 0,
            conflictingFileCount: 0,
            truncated: false,
            truncatedBy: null,
            stopLimit: 200,
            timeLimitSeconds: 600,
          },
          censusUnavailableReason: null,
        },
        blocked: { newestUpstreamTagBeyondWindow: "v1.2.0" },
      };
      mutate(envelope);
      NodeFS.writeFileSync(artifact, JSON.stringify(envelope));
      return NodeFS.readFileSync(receiptPath, "utf8");
    };
    const censusOf = (envelope: Record<string, unknown>): Record<string, unknown> =>
      (envelope.decision as Record<string, unknown>).census as Record<string, unknown>;
    const evidenceOf = (envelope: Record<string, unknown>): Record<string, unknown> =>
      censusOf(envelope).evidence as Record<string, unknown>;
    const refusals: ReadonlyArray<[string, (envelope: Record<string, unknown>) => void]> = [
      [
        "unsupported envelope version",
        (envelope) => {
          envelope.schemaVersion = 2;
        },
      ],
      [
        "evidence missing method",
        (envelope) => {
          delete evidenceOf(envelope).method;
        },
      ],
      [
        "evidence missing sourceSha",
        (envelope) => {
          delete evidenceOf(envelope).sourceSha;
        },
      ],
      [
        "evidence with malformed baseSha",
        (envelope) => {
          evidenceOf(envelope).baseSha = "z".repeat(40);
        },
      ],
      [
        "evidence missing targetSha",
        (envelope) => {
          delete evidenceOf(envelope).targetSha;
        },
      ],
      [
        "evidence targetTag disagrees with the stop",
        (envelope) => {
          evidenceOf(envelope).targetTag = "v1.3.0";
        },
      ],
    ];
    for (const [name, mutate] of refusals) {
      envelopeWith(mutate);
      assert.strictEqual(runCensus(), 1, name);
      assert.deepStrictEqual(
        JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")),
        { publication: "not-attempted", policy: "not-attempted" },
        name,
      );
    }

    // Census unavailable with no blocked conflicts: live evidence was requested
    // but cannot be assessed, so the verdict is a distinct non-passing reason
    // (RSI-Software/t3code-hyprws#860), never a history-only success.
    NodeFS.writeFileSync(
      artifact,
      JSON.stringify({
        schemaVersion: 1,
        decision: {
          pairwiseFirstConflict: null,
          census: null,
          censusUnavailableReason: "the walk died before the census ran",
        },
        blocked: null,
      }),
    );
    assert.strictEqual(runCensus(), 0);
    assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")), {
      publication: "not-attempted",
      policy: "failed",
      reason: "census-unavailable",
    });

    // Count-only census: the feasibility overlap conflicts are the structured
    // fallback the block issue always carried, so the live recurrence keeps its
    // blocking returned-unresolved verdict instead of dropping to history.
    NodeFS.writeFileSync(
      artifact,
      JSON.stringify({
        schemaVersion: 1,
        decision: {
          pairwiseFirstConflict: null,
          census: {
            targetTag: "v1.2.0",
            conflictingForkCommitCount: 1,
            conflictingFileCount: 1,
            truncated: false,
            truncatedBy: null,
            stopLimit: 200,
            timeLimitSeconds: 600,
          },
          censusUnavailableReason: null,
        },
        blocked: {
          newestUpstreamTagBeyondWindow: "v1.2.0",
          conflicts: [
            {
              path,
              hunks: 1,
              forkCommit: "1".repeat(40),
              forkCommitShort: "1111111",
              forkSubject: subject,
              domain: "fork-meta",
            },
          ],
        },
      }),
    );
    assert.strictEqual(runCensus(), 0);
    assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")), {
      publication: "not-attempted",
      policy: "failed",
      reason: "blocking-seams",
    });

    // Empty but complete: live evidence that the seam is gone - a real
    // observation, not an unavailable census.
    const evidence = (complete: boolean) => ({
      version: 2,
      method: "sequential-rebase-walk-resolution",
      sourceSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      targetSha: "c".repeat(40),
      targetTag: "v1.2.0",
      complete,
      rows: [],
    });
    NodeFS.writeFileSync(
      artifact,
      JSON.stringify({
        schemaVersion: 1,
        decision: {
          pairwiseFirstConflict: null,
          census: {
            targetTag: "v1.2.0",
            evidence: evidence(true),
            conflictingForkCommitCount: 0,
            conflictingFileCount: 0,
            truncated: false,
            truncatedBy: null,
            stopLimit: 200,
            timeLimitSeconds: 600,
          },
          censusUnavailableReason: null,
        },
        blocked: { newestUpstreamTagBeyondWindow: "v1.2.0" },
      }),
    );
    assert.strictEqual(runCensus(), 0);
    assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")), {
      publication: "not-attempted",
      policy: "succeeded",
    });

    // Empty and partial: truncation to zero rows says nothing about presence,
    // so discarding it is a non-passing verdict, not a pass.
    NodeFS.writeFileSync(
      artifact,
      JSON.stringify({
        schemaVersion: 1,
        decision: {
          pairwiseFirstConflict: null,
          census: {
            targetTag: "v1.2.0",
            evidence: evidence(false),
            conflictingForkCommitCount: 0,
            conflictingFileCount: 0,
            truncated: true,
            truncatedBy: "stop-limit",
            stopLimit: 200,
            timeLimitSeconds: 600,
          },
          censusUnavailableReason: null,
        },
        blocked: { newestUpstreamTagBeyondWindow: "v1.2.0" },
      }),
    );
    assert.strictEqual(runCensus(), 0);
    assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")), {
      publication: "not-attempted",
      policy: "failed",
      reason: "census-unavailable",
    });

    // None of the paths above touched GitHub: no read, no POST, no gh at all.
    assert.strictEqual(NodeFS.readFileSync(calls, "utf8"), "");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCalls === undefined) delete process.env.SEAM_GH_CALLS;
    else process.env.SEAM_GH_CALLS = previousCalls;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
