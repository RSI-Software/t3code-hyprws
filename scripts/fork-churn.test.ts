// @effect-diagnostics nodeBuiltinImport:off - Temporary ledger fixtures use Node helpers.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  censusChurn,
  commentRestId,
  DOCUMENT_PATH,
  enrichCensusSubjects,
  hotSeams,
  parseCensusFiles,
  parseCensusTag,
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
import { CHURN_MARKER, regressedSeamLines, renderChurnSection } from "./fork-churn-section.ts";
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

  assert.deepStrictEqual(churn.regressions, [
    {
      path,
      commit: "3333333",
      subject,
      domain: "fork-meta",
      tag: "v3",
      fixedAt,
    },
  ]);
  assert.deepStrictEqual(regressedSeamLines(churn), [
    `regressed seam: \`${path}\` / \`${subject}\` (fork-meta) was fixed at \`${fixedAt}\` and reappeared on \`v3\` as \`3333333\``,
  ]);
  assert.include(
    renderChurnSection(entries, null, {
      tag: "v3",
      fixedAt: null,
      files: [censusFile(path, "3333333", subject)],
    }),
    "regressed seam:",
  );
});

it("keeps a returned seam failed until the newest census is clean", () => {
  const path = "apps/web/src/regressed.ts";
  const subject = "feat(web): keep the seam";
  const entries = [
    censusEntry("v1", [censusFile(path, "1111111", subject)]),
    censusEntry("v2", [censusFile("other.ts", "2222222", "feat: other")]),
    censusEntry("v3", [censusFile(path, "3333333", subject)]),
  ];

  assert.deepStrictEqual(
    censusChurn(entries, {
      tag: "v4",
      fixedAt: null,
      files: [censusFile(path, "4444444", subject)],
    }).regressions,
    [
      {
        path,
        commit: "4444444",
        subject,
        domain: "fork-meta",
        tag: "v4",
        fixedAt: B,
      },
    ],
  );
  assert.deepStrictEqual(
    censusChurn(entries, {
      tag: "v4",
      fixedAt: null,
      files: [censusFile("latest.ts", "4444444", "feat: latest")],
    }).regressions,
    [],
  );
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
    }).regressions.map(({ path, domain }) => ({ path, domain })),
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

it("enriches every legacy census subject on the next append", () => {
  const root = repository();
  const tree = runCommandText("git", ["mktree"], { cwd: root, input: "" }).trim();
  const legacyCommit = runCommandText(
    "git",
    ["commit-tree", tree, "-m", "feat(fork): durable legacy identity"],
    { cwd: root },
  ).trim();
  const legacy = censusEntry("v0", [
    {
      path: "scripts/legacy.ts",
      hunks: 1,
      commit: legacyCommit.slice(0, 12),
      domain: "fork-meta",
    },
  ]);
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
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_GH_RESPONSE = JSON.stringify({
    body: [
      "## Sequential rebase census",
      "",
      "A throwaway rebase rehearsal to `v1` found 1 conflicting fork commit and 1 conflict-file resolution.",
      "",
      "| File | Hunks | Fork commit | Domain |",
      "| --- | ---: | --- | --- |",
      "| `scripts/current.ts` | 1 | `1234567 feat(fork): current identity` | fork-meta |",
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
          A,
          "--after",
          B,
        ],
        root,
      ),
      0,
    );
    const persisted = parseLedger(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE) ?? "");
    assert.isTrue(persisted.flatMap((entry) => entry.censusFiles).every((file) => file.subject));
    assert.strictEqual(
      persisted[0]?.censusFiles[0]?.subject,
      "feat(fork): durable legacy identity",
    );

    runCommandText("git", ["prune", "--expire=now"], { cwd: root });
    assert.throws(() =>
      runCommandText("git", ["cat-file", "-e", `${legacyCommit}^{commit}`], { cwd: root }),
    );
    assert.deepStrictEqual(
      censusChurn(
        enrichCensusSubjects(persisted, () => {
          throw new Error("old Git object was consulted");
        }),
      ).regressions,
      [],
    );
    assert.strictEqual(run(["render"], root), 0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousResponse === undefined) delete process.env.FAKE_GH_RESPONSE;
    else process.env.FAKE_GH_RESPONSE = previousResponse;
    NodeFS.rmSync(root, { recursive: true, force: true });
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
