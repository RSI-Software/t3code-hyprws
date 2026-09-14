// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { FORK_PR_TEMPLATE_PATH } from "./lib/fork-pr-template.ts";
import { parseForkRetirementLedger, retirementDecision } from "./lib/fork-retirement-ledger.ts";
import { FORK_DOMAINS } from "./lib/fork-trailers.ts";
import {
  buildInventory,
  buildLedger,
  buildSquashLedger,
  collectWireShapeFindings,
  collectWireShapeFindingsBetween,
  collectFindings,
  dropTransientFixups,
  forkLogArguments,
  grandfatheredWalkRepairKey,
  legacyWalkRepairFindings,
  parseCommitNumstat,
  parseForkLog,
  parseSquashBody,
  readForkLog,
  renderInventory,
  renderMarkdown,
  renderShas,
  selectDomain,
  squashTrailers,
} from "./fork-delta.ts";

const RS = "";
const FS = "";

const wireFinding = {
  schema: "ThreadEnvMode",
  change: "literal added: worktrunk",
  hint: "add an optional fork-only sibling field instead, or add trailer Fork-Wire: reviewed <reason>",
};

const renamedSchemaFinding = {
  schema: "ThreadEnvMode",
  change: "schema removed or renamed",
  hint: "add an optional fork-only sibling field instead, or add trailer Fork-Wire: reviewed <reason>",
};

const ipcFinding = {
  schema: "ipc.ts",
  change: "desktop IPC shape changed",
  hint: "add an optional fork-only sibling field instead, or add trailer Fork-Wire: reviewed <reason>",
};

const forkDeltaScript = NodePath.join(import.meta.dirname, "fork-delta.ts");

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fork Delta Test", "-c", "user.email=fork-delta@example.com", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: NodePath.join(root, ".isolated-global-gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  ).trim();

const createGitFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-delta-squash-"));
  const contracts = NodePath.join(root, "packages/contracts/src");
  NodeFS.mkdirSync(contracts, { recursive: true });
  // `--check` refuses a pull-request template whose domain list drifts from FORK_DOMAINS, so
  // every fixture repository carries one. Generated rather than pasted: a fixture that drifts
  // from the constant is the same bug the guard exists to catch.
  NodeFS.mkdirSync(NodePath.join(root, ".github"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, FORK_PR_TEMPLATE_PATH),
    [
      "<!-- Valid Fork-Domain values (copy one exactly):",
      ...FORK_DOMAINS.map((domain) => `       ${domain}`),
      "-->",
      "",
    ].join("\n"),
  );
  git(root, ["init", "-b", "fixture"]);
  return { root, contracts };
};

const commitAll = (root: string, subject: string, body?: string): string => {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", subject, ...(body === undefined ? [] : ["-m", body])]);
  return git(root, ["rev-parse", "HEAD"]);
};

const DEFAULT_AUTHOR_DATE = "2026-01-01T00:00:00+00:00";

const record = (
  short: string,
  subject: string,
  trailers: string,
  authorDate: string = DEFAULT_AUTHOR_DATE,
) =>
  `${short.padEnd(40, "0")}${FS}${short}${FS}${authorDate}${FS}${subject}${FS}${trailers}${RS}\n`;

const fixture =
  record(
    "aaaaaaaaa",
    "fix(web): scope markdown actions",
    "Fork-Domain: project-windows\nFork-Tier: bugfix\nFork-Upstreamable: yes\n",
  ) +
  record(
    "bbbbbbbbb",
    "feat(desktop): register windows | by identity",
    "Fork-Domain: project-windows\nFork-Tier: core\n",
  ) +
  record("ccccccccc", "docs(readme): hyprws", "Fork-Domain: fork-meta\nFork-Tier: qol\n") +
  record("ddddddddd", "chore: untagged", "") +
  record("eeeeeeeee", "fix(web): wrong tier", "Fork-Domain: project-windows\nFork-Tier: polish\n");

it("asks git for the fork range in stack order", () => {
  assert.deepStrictEqual(forkLogArguments("upstream/main", "HEAD").slice(0, 2), [
    "log",
    "--reverse",
  ]);
  assert.strictEqual(forkLogArguments("upstream/main", "HEAD").at(-1), "upstream/main..HEAD");
});

it("parses trailers and omits absent ones", () => {
  const commits = parseForkLog(fixture);
  assert.strictEqual(commits.length, 5);
  assert.deepStrictEqual(commits[0], {
    sha: "aaaaaaaaa".padEnd(40, "0"),
    short: "aaaaaaaaa",
    authorDate: DEFAULT_AUTHOR_DATE,
    subject: "fix(web): scope markdown actions",
    domain: "project-windows",
    tier: "bugfix",
    upstreamable: "yes",
  });
  assert.deepStrictEqual(commits[3], {
    sha: "ddddddddd".padEnd(40, "0"),
    short: "ddddddddd",
    authorDate: DEFAULT_AUTHOR_DATE,
    subject: "chore: untagged",
  });
});

it("reports missing and unknown trailers", () => {
  const findings = collectFindings(parseForkLog(fixture));
  assert.deepStrictEqual(
    findings.map((finding) => `${finding.short}: ${finding.problem}`),
    [
      "ddddddddd: missing Fork-Domain",
      "ddddddddd: missing Fork-Tier",
      'eeeeeeeee: unknown Fork-Tier "polish" (expected core, qol, bugfix)',
    ],
  );
});

it("ignores trailer-free walk fixups entirely: the autosquash folds them after the check", () => {
  const withFixup = parseForkLog(
    record("bbbbbbbbb", "fixup! fix(web): scope markdown actions", "") +
      record(
        "aaaaaaaaa",
        "fix(web): scope markdown actions",
        "Fork-Domain: project-windows\nFork-Tier: bugfix\nFork-Upstreamable: yes\n",
      ),
  );
  const folded = dropTransientFixups(withFixup);
  assert.deepStrictEqual(
    folded.map((commit) => commit.short),
    ["aaaaaaaaa"],
  );
  assert.deepStrictEqual(collectFindings(folded), []);
  assert.deepStrictEqual(legacyWalkRepairFindings(folded, new Set()), []);
});

it("refuses an ungrandfathered legacy walk repair but ignores absent grandfather entries", () => {
  const legacy = parseForkLog(
    record(
      "hhhhhhhhh",
      "chore(fork-sync): repair fmt after v1.2.3",
      "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no\nFork-Repair: v1.2.3\n",
    ),
  );
  assert.deepStrictEqual(
    legacyWalkRepairFindings(legacy, new Set()).map((finding) => finding.problem),
    ["legacy walk repair must be folded"],
  );
  assert.deepStrictEqual(
    legacyWalkRepairFindings(legacy, new Set([grandfatheredWalkRepairKey(legacy[0]!)])),
    [],
  );
  // A grandfather entry with no reachable commit is deliberately a no-op.
  assert.deepStrictEqual(legacyWalkRepairFindings([], new Set(["f".repeat(40)])), []);
});

it("accepts a grandfathered walk repair commit the sync appended after the replayed series", () => {
  const commits = parseForkLog(
    record(
      "hhhhhhhhh",
      "chore(fork-sync): repair fmt after v1.2.3",
      "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no\nFork-Repair: v1.2.3\n",
    ),
  );
  // The repair declares the walk that wrote it, and the ledger check reads it as any other
  // fork commit: it is appended, never folded into the commit it repairs.
  assert.strictEqual(commits[0]?.repair, "v1.2.3");
  assert.deepStrictEqual(collectFindings(commits), []);
});

it("keys the walk-repair exemption on (author date, subject) so a fold's new sha stays exempt", () => {
  const authorDate = "2026-09-08T14:28:59+12:00";
  const subject = "chore(fork-sync): repair typecheck after v0.0.41-nightly.20260908.1414";
  const grandfathered = new Set([grandfatheredWalkRepairKey({ authorDate, subject })]);

  // A fold rewrites tree/parent, changing the sha, but rebuildCommit copies the author header
  // and message verbatim: same (author date, subject), unrelated sha, must stay exempt.
  const rewritten = parseForkLog(
    record(
      "111111111",
      subject,
      "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no\n",
      authorDate,
    ),
  );
  assert.deepStrictEqual(legacyWalkRepairFindings(rewritten, grandfathered), []);

  // The trap: three real entries in this series share this exact subject with different author
  // dates. Subject alone would wrongly exempt this counter-case; the author date must matter too.
  const sameSubjectDifferentAuthorDate = parseForkLog(
    record(
      "222222222",
      subject,
      "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no\n",
      "2026-09-09T14:36:47+12:00",
    ),
  );
  assert.deepStrictEqual(
    legacyWalkRepairFindings(sameSubjectDifferentAuthorDate, grandfathered).map(
      (finding) => finding.problem,
    ),
    ["legacy walk repair must be folded"],
  );
});

it("validates Fork-Domain and Fork-Upstreamable values", () => {
  const findings = collectFindings(
    parseForkLog(
      record("fffffffff", "fix: x", "Fork-Domain: typoo\nFork-Tier: bugfix\n") +
        record(
          "ggggggggg",
          "fix: y",
          "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: maybe\n",
        ),
    ),
  );
  assert.deepStrictEqual(
    findings.map((finding) => finding.problem),
    [
      'unknown Fork-Domain "typoo"',
      "bugfix without Fork-Upstreamable",
      'unknown Fork-Upstreamable "maybe" (expected yes or no)',
    ],
  );
});

it("reads trailers a GitHub UI squash left above the co-author paragraph", () => {
  const [commit] = parseForkLog(
    record(
      "999999999",
      "fix(scripts): ui squash (#88)",
      "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no\n\nCo-authored-by: donjor <donjor@example.com>\n",
    ),
  );
  assert.strictEqual(commit?.domain, "fork-meta");
  assert.strictEqual(commit?.tier, "bugfix");
  assert.strictEqual(commit?.upstreamable, "no");
});

it("reads trailers a stack comment and co-author paragraph sit below (134a11855d)", () => {
  const [commit] = parseForkLog(
    record(
      "888888888",
      "feat(zmux-estate): checkout moves",
      'Fork-Domain: zmux-estate\nFork-Tier: core\n\n<!-- gh-bot:stack {"v":1,"parent":609,"root":"hyprws"} -->\n\nCo-authored-by: donjor <38745786+donjor@users.noreply.github.com>\n',
    ),
  );
  assert.strictEqual(commit?.domain, "zmux-estate");
  assert.strictEqual(commit?.tier, "core");
});

it("renders one table per domain with tiers ordered core, qol, bugfix", () => {
  const markdown = renderMarkdown(buildLedger("upstream/main", "HEAD", parseForkLog(fixture)));
  const lines = markdown.split("\n");
  const projectWindows = lines.indexOf("## project-windows");
  const forkMeta = lines.indexOf("## fork-meta");
  assert.ok(projectWindows !== -1 && forkMeta !== -1);
  assert.strictEqual(
    lines[projectWindows + 4],
    "| core | `bbbbbbbbb` | feat(desktop): register windows \\| by identity |  |  |",
  );
  assert.strictEqual(
    lines[projectWindows + 5],
    "| bugfix | `aaaaaaaaa` | fix(web): scope markdown actions | yes |  |",
  );
  assert.ok(lines.includes("## Untagged"));
  assert.ok(
    lines.some((line) =>
      line.startsWith("| `ddddddddd` | chore: untagged | missing Fork-Domain |"),
    ),
  );
});

it("skips retired subjects from listings and makes --check fail while one is present", () => {
  const retirementLedger = parseForkRetirementLedger(
    "## Retired\n\n| Fork commit | Domain | Upstream replacement | Retired at |\n| --- | --- | --- | --- |\n| fix(web): scope markdown actions | project-windows | `canonical/project#123` | v1.0.0 |\n\n## Kept\n\n| Fork commit | Domain | Reason | Reviewed at |\n| --- | --- | --- | --- |\n",
  );
  const ledger = buildLedger("upstream/main", "HEAD", parseForkLog(fixture), retirementLedger);
  assert.notInclude(
    ledger.commits.map((commit) => commit.subject),
    "fix(web): scope markdown actions",
  );
  assert.deepInclude(ledger.findings, {
    short: "aaaaaaaaa",
    subject: "fix(web): scope markdown actions",
    problem: "retired but present",
  });
  assert.isAbove(ledger.findings.length, 0);
});

it("fails kept but absent: a Kept row whose commit left the stack without a Retired row", () => {
  const retirementLedger = parseForkRetirementLedger(
    "## Retired\n\n| Fork commit | Domain | Upstream replacement | Retired at |\n| --- | --- | --- | --- |\n\n## Kept\n\n| Fork commit | Domain | Reason | Reviewed at |\n| --- | --- | --- | --- |\n| feat(web): add manual sidebar thread ordering | thread-ordering | kept for fork users | v1.0.0 |\n",
  );
  const ledger = buildLedger("upstream/main", "HEAD", parseForkLog(fixture), retirementLedger);
  assert.deepInclude(ledger.findings, {
    short: "ledger",
    subject: "feat(web): add manual sidebar thread ordering",
    problem: "kept but absent",
  });
});

it("resolves a subject written as a code span to its bare commit subject", () => {
  const backticked = parseForkRetirementLedger(
    "## Retired\n\n| Fork commit | Domain | Upstream replacement | Retired at |\n| --- | --- | --- | --- |\n| `fix(web): scope markdown actions` | project-windows | `canonical/project#123` | v1.0.0 |\n\n## Kept\n\n| Fork commit | Domain | Reason | Reviewed at |\n| --- | --- | --- | --- |\n",
  );
  // The exact subject the commit carries, and the backticked spelling, are the
  // same key: a code span in the table must not silently resolve to none.
  assert.strictEqual(
    retirementDecision(backticked, "fix(web): scope markdown actions").decision,
    "retire",
  );
  assert.strictEqual(
    retirementDecision(backticked, "`fix(web): scope markdown actions`").decision,
    "retire",
  );
  // Inner or unpaired backticks are part of the subject, not its wrapping.
  const bare = parseForkRetirementLedger(
    "## Retired\n\n| Fork commit | Domain | Upstream replacement | Retired at |\n| --- | --- | --- | --- |\n| fix(web): scope `markdown` actions | project-windows | `canonical/project#123` | v1.0.0 |\n\n## Kept\n\n| Fork commit | Domain | Reason | Reviewed at |\n| --- | --- | --- | --- |\n",
  );
  assert.strictEqual(
    retirementDecision(bare, "fix(web): scope `markdown` actions").decision,
    "retire",
  );
  assert.strictEqual(retirementDecision(bare, "fix(web): scope markdown actions").decision, "none");
});

it("keeps a partial subject active when its retired and kept portions are both recorded", () => {
  const retirementLedger = parseForkRetirementLedger(
    "## Retired\n\n| Fork commit | Domain | Upstream replacement | Retired at |\n| --- | --- | --- | --- |\n| fix(web): scope markdown actions | project-windows | `canonical/project#123` | v1.0.0 |\n\n## Kept\n\n| Fork commit | Domain | Reason | Reviewed at |\n| --- | --- | --- | --- |\n| fix(web): scope markdown actions | project-windows | project scope remains | v1.0.0 |\n",
  );
  const ledger = buildLedger("upstream/main", "HEAD", parseForkLog(fixture), retirementLedger);
  assert.include(
    ledger.commits.map((commit) => commit.subject),
    "fix(web): scope markdown actions",
  );
  assert.notInclude(
    ledger.findings.map((finding) => finding.problem),
    "retired but present",
  );
});

it("records a reviewed Fork-Wire trailer and skips that commit's wire findings", () => {
  const [commit] = parseForkLog(
    record(
      "ababababa",
      "feat(contracts): reviewed wire change",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Wire: reviewed released clients accept the sibling\n",
    ),
  );
  assert.isDefined(commit);
  const wireFinding = {
    schema: "ThreadEnvMode",
    change: "literal added: worktrunk",
    hint: "add an optional fork-only sibling field instead, or add trailer Fork-Wire: reviewed <reason>",
  };
  const ledger = buildLedger(
    "upstream/main",
    "HEAD",
    [commit],
    undefined,
    new Map([[commit.sha, [wireFinding]]]),
  );
  assert.strictEqual(commit.wireReviewed, "reviewed released clients accept the sibling");
  assert.deepStrictEqual(ledger.findings, []);
  assert.include(renderMarkdown(ledger), "reviewed released clients accept the sibling");
});

it("skips a shipped wire finding listed in the baseline", () => {
  const [commit] = parseForkLog(
    record(
      "adadadada",
      "feat(contracts): shipped wire change",
      "Fork-Domain: fork-meta\nFork-Tier: qol\n",
    ),
  );
  assert.isDefined(commit);
  const finding = {
    schema: "Mode",
    change: "literal added: fork",
    hint: "add an optional fork-only sibling field instead, or add trailer Fork-Wire: reviewed <reason>",
  };
  const ledger = buildLedger(
    "upstream/main",
    "HEAD",
    [commit],
    undefined,
    new Map([[commit.sha, [finding]]]),
    new Map([["Mode: literal added: fork", "shipped before the wire check"]]),
  );
  assert.deepStrictEqual(ledger.findings, []);
  assert.deepStrictEqual(ledger.warnings, []);
});

it("warns without failing when a wire baseline key becomes stale", () => {
  const ledger = buildLedger(
    "upstream/main",
    "HEAD",
    [],
    undefined,
    new Map(),
    new Map([["Mode: literal added: retired", "shipped before the wire check"]]),
  );
  assert.deepStrictEqual(ledger.findings, []);
  assert.deepStrictEqual(ledger.warnings, ["stale wire baseline: Mode: literal added: retired"]);
});

it("does not accept a Fork-Wire trailer without a review reason", () => {
  const [commit] = parseForkLog(
    record(
      "acacacaca",
      "feat(contracts): unreviewed wire change",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Wire: reviewed\n",
    ),
  );
  assert.isDefined(commit);
  const ledger = buildLedger(
    "upstream/main",
    "HEAD",
    [commit],
    undefined,
    new Map([
      [
        commit.sha,
        [
          {
            schema: "Mode",
            change: "literal added: fork",
            hint: "add an optional fork-only sibling field instead, or add trailer Fork-Wire: reviewed <reason>",
          },
        ],
      ],
    ]),
  );
  assert.strictEqual(ledger.findings.length, 1);
});

it("selects one domain with its findings in stack order", () => {
  const ledger = buildLedger("upstream/main", "HEAD", parseForkLog(fixture));
  const selected = selectDomain(ledger, "project-windows");
  assert.isNotNull(selected);
  assert.deepStrictEqual(
    selected.commits.map((commit) => commit.short),
    ["aaaaaaaaa", "bbbbbbbbb", "eeeeeeeee"],
  );
  assert.deepStrictEqual(
    selected.findings.map((finding) => finding.short),
    ["eeeeeeeee"],
  );
  assert.isNull(selectDomain(ledger, "markdown-editor"));
});

it("renders full SHAs one per line for cherry-pick", () => {
  const ledger = buildLedger("upstream/main", "HEAD", parseForkLog(fixture));
  const selected = selectDomain(ledger, "fork-meta");
  assert.isNotNull(selected);
  assert.strictEqual(renderShas(selected), `${"ccccccccc".padEnd(40, "0")}\n`);
});

const squashBody = [
  "Thread terminals attach into the managed session.",
  "",
  "Closes #17",
  "",
  "@donjor",
  "",
  "Fork-Domain: zmux-estate",
  "Fork-Tier: core",
  "",
  '<!-- gh-bot:attest {"v":2,"ts":"2026-08-23T09:41:33Z"} -->',
  "",
].join("\n");

it("reads the trailer block a squash commit inherits from a pull-request body", () => {
  assert.strictEqual(squashTrailers(squashBody), "Fork-Domain: zmux-estate\nFork-Tier: core");
  const commit = parseSquashBody("pull-request body", squashBody);
  assert.deepStrictEqual(collectFindings([commit]), []);
  assert.strictEqual(commit.domain, "zmux-estate");
  assert.strictEqual(commit.tier, "core");
});

it("requires a reviewed wire trailer in the squash body when the prospective squash changes wire shape", () => {
  const missing = buildSquashLedger("base", "head", squashBody, [wireFinding]);
  assert.deepStrictEqual(
    missing.findings.map((finding) => finding.problem),
    [`${wireFinding.schema}: ${wireFinding.change}; ${wireFinding.hint}`],
  );

  const reasonless = buildSquashLedger(
    "base",
    "head",
    squashBody.replace("Fork-Tier: core", "Fork-Tier: core\nFork-Wire: reviewed"),
    [wireFinding],
  );
  assert.deepStrictEqual(reasonless.findings, missing.findings);

  const reviewed = buildSquashLedger(
    "base",
    "head",
    squashBody.replace(
      "Fork-Tier: core",
      "Fork-Tier: core\nFork-Wire: reviewed released clients accept the new mode",
    ),
    [wireFinding],
  );
  assert.deepStrictEqual(reviewed.findings, []);
  assert.deepStrictEqual(buildSquashLedger("base", "head", squashBody, []).findings, []);
});

it("checks the complete multi-commit squash instead of accepting an intermediate wire review", async () => {
  const { root, contracts } = createGitFixture();
  try {
    const schemaPath = NodePath.join(contracts, "orchestration.ts");
    NodeFS.writeFileSync(
      schemaPath,
      'import * as Schema from "effect/Schema";\nexport const ThreadEnvMode = Schema.Literals(["plain"]);\n',
    );
    const base = commitAll(root, "fixture: base");

    NodeFS.writeFileSync(
      schemaPath,
      'import * as Schema from "effect/Schema";\nexport const ThreadEnvMode = Schema.Literals(["plain", "worktrunk"]);\n',
    );
    commitAll(
      root,
      "feat(contracts): add worktrunk mode",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Wire: reviewed fixture intermediate commit",
    );
    NodeFS.writeFileSync(NodePath.join(root, "server.ts"), "export const wired = true;\n");
    const head = commitAll(
      root,
      "feat(server): consume worktrunk mode",
      "Fork-Domain: fork-meta\nFork-Tier: qol",
    );

    const evidence = await Effect.gen(function* () {
      const commits = yield* readForkLog(base, head, root);
      const perCommitFindings = yield* collectWireShapeFindings(commits, root);
      const squashFindings = yield* collectWireShapeFindingsBetween(base, head, root);
      return { commits, perCommitFindings, squashFindings };
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
    assert.deepStrictEqual(
      buildLedger(base, head, evidence.commits, undefined, evidence.perCommitFindings).findings,
      [],
    );
    assert.deepStrictEqual(evidence.squashFindings, [wireFinding]);
    assert.deepStrictEqual(
      buildSquashLedger(base, head, squashBody, evidence.squashFindings).findings.map(
        (finding) => finding.problem,
      ),
      [`${wireFinding.schema}: ${wireFinding.change}; ${wireFinding.hint}`],
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("requires squash-body review when a schema rename hides a new literal", async () => {
  const { root, contracts } = createGitFixture();
  try {
    const schemaPath = NodePath.join(contracts, "orchestration.ts");
    NodeFS.writeFileSync(
      schemaPath,
      'import * as Schema from "effect/Schema";\nexport const ThreadEnvMode = Schema.Literals(["plain"]);\n',
    );
    const base = commitAll(root, "fixture: base");
    NodeFS.writeFileSync(
      schemaPath,
      'import * as Schema from "effect/Schema";\nexport const ForkThreadEnvMode = Schema.Literals(["plain", "worktrunk"]);\n',
    );
    const head = commitAll(root, "feat(contracts): rename mode and add worktrunk");

    const findings = await collectWireShapeFindingsBetween(base, head, root).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    assert.deepStrictEqual(findings, [renamedSchemaFinding]);
    assert.deepStrictEqual(
      buildSquashLedger(base, head, squashBody, findings).findings.map(
        (finding) => finding.problem,
      ),
      [
        `${renamedSchemaFinding.schema}: ${renamedSchemaFinding.change}; ${renamedSchemaFinding.hint}`,
      ],
    );
    assert.deepStrictEqual(
      buildSquashLedger(
        base,
        head,
        squashBody.replace(
          "Fork-Tier: core",
          "Fork-Tier: core\nFork-Wire: reviewed fixture schema rename",
        ),
        findings,
      ).findings,
      [],
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("excludes changes unique to a diverged live base", async () => {
  const { root, contracts } = createGitFixture();
  try {
    const schemaPath = NodePath.join(contracts, "orchestration.ts");
    NodeFS.writeFileSync(
      schemaPath,
      [
        'import * as Schema from "effect/Schema";',
        'export const ThreadEnvMode = Schema.Literals(["plain"]);',
        "export const CheckoutMove = Schema.Struct({ id: Schema.String });",
        "",
      ].join("\n"),
    );
    const common = commitAll(root, "fixture: common ancestor");
    git(root, ["switch", "-c", "pull-request"]);
    NodeFS.writeFileSync(
      schemaPath,
      [
        'import * as Schema from "effect/Schema";',
        'export const ThreadEnvMode = Schema.Literals(["plain", "worktrunk"]);',
        "export const CheckoutMove = Schema.Struct({ id: Schema.String });",
        "",
      ].join("\n"),
    );
    const head = commitAll(root, "feat(contracts): change pull request wire");

    git(root, ["switch", "-c", "live-base", common]);
    NodeFS.writeFileSync(
      schemaPath,
      [
        'import * as Schema from "effect/Schema";',
        'export const ThreadEnvMode = Schema.Literals(["plain"]);',
        "export const CheckoutMove = Schema.Struct({ id: Schema.String, baseOnly: Schema.String });",
        "",
      ].join("\n"),
    );
    const liveBase = commitAll(root, "feat(contracts): change live base wire");

    const findings = await collectWireShapeFindingsBetween(liveBase, head, root).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    assert.deepStrictEqual(findings, [wireFinding]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("reads added and deleted contract files from the compared revisions", async () => {
  const { root, contracts } = createGitFixture();
  try {
    NodeFS.writeFileSync(NodePath.join(root, "README.md"), "fixture\n");
    const base = commitAll(root, "fixture: base");
    const ipcPath = NodePath.join(contracts, "ipc.ts");
    NodeFS.writeFileSync(
      ipcPath,
      'import * as Schema from "effect/Schema";\nexport const DesktopRequest = Schema.Struct({ name: Schema.String });\n',
    );
    const added = commitAll(root, "feat(contracts): add IPC file");
    NodeFS.rmSync(ipcPath);
    const deleted = commitAll(root, "feat(contracts): delete IPC file");

    const [addedFindings, deletedFindings] = await Effect.all(
      [
        collectWireShapeFindingsBetween(base, added, root),
        collectWireShapeFindingsBetween(added, deleted, root),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
    assert.deepStrictEqual(addedFindings, [ipcFinding]);
    assert.deepStrictEqual(deletedFindings, [ipcFinding]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("requires explicit squash refs with a usage exit and stderr diagnostic", () => {
  const { root } = createGitFixture();
  try {
    const bodyPath = NodePath.join(root, "body.md");
    NodeFS.writeFileSync(bodyPath, squashBody);
    const missingBoth = NodeChildProcess.spawnSync(
      process.execPath,
      [forkDeltaScript, "--check", "--squash-body", bodyPath],
      { cwd: root, encoding: "utf8" },
    );
    assert.strictEqual(missingBoth.status, 2);
    assert.strictEqual(missingBoth.stdout, "");
    assert.strictEqual(
      missingBoth.stderr.trimEnd(),
      "failed: --squash-body requires explicit --base and --head",
    );

    const missingHead = NodeChildProcess.spawnSync(
      process.execPath,
      [forkDeltaScript, "--check", "--base", "HEAD", "--squash-body", bodyPath],
      { cwd: root, encoding: "utf8" },
    );
    assert.strictEqual(missingHead.status, 2);
    assert.strictEqual(missingHead.stdout, "");
    assert.strictEqual(
      missingHead.stderr.trimEnd(),
      "failed: --squash-body requires explicit --head",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("passes the live base ref and exact pull-request head to squash-body validation", () => {
  const workflow = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "../.github/workflows/hyprws-body.yml"),
    "utf8",
  );
  assert.include(workflow, "BASE_REF: origin/hyprws");
  assert.include(workflow, "HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
  assert.notInclude(workflow, "github.event.pull_request.base.sha");
  assert.include(
    workflow,
    'fork:delta --check --base "$BASE_REF" --head "$HEAD_SHA" --squash-body',
  );
  // No upstream remote is added here: with the budget projection retired, the
  // body check resolves its merge base from --base and --head alone.
  assert.notInclude(workflow, "git fetch --no-tags upstream main");
});

it("fails a pull-request body whose last paragraph is prose, not trailers", () => {
  const body = "Provider spawns pass the complete environment.\n\nCloses #19\n\n@donjor\n";
  assert.strictEqual(squashTrailers(body), "");
  const findings = collectFindings([parseSquashBody("pull-request body", body)]);
  assert.deepStrictEqual(
    findings.map((finding) => finding.problem),
    ["missing Fork-Domain", "missing Fork-Tier"],
  );
});

it("ignores trailers that sit above the mention instead of ending the body", () => {
  const body = "Fork-Domain: fork-meta\nFork-Tier: qol\n\n@donjor\n";
  assert.strictEqual(squashTrailers(body), "");
});

it("parses per-commit numstat records, counting binary files but not their lines", () => {
  const raw = `${RS}abc\n3\t1\tapps/web/src/app.ts\n-\t-\tassets/logo.png\n${RS}def\n0\t0\tdocs/internals/fork-delta.md\n`;
  const stats = parseCommitNumstat(raw);
  assert.deepStrictEqual(stats.get("abc"), {
    files: ["apps/web/src/app.ts", "assets/logo.png"],
    added: 3,
    deleted: 1,
  });
  assert.deepStrictEqual(stats.get("def"), {
    files: ["docs/internals/fork-delta.md"],
    added: 0,
    deleted: 0,
  });
});

it("parses a numstat record with the blank line git puts after the format header", () => {
  const raw = `${RS}abc\n\n3\t1\tapps/web/src/app.ts\n`;
  const stats = parseCommitNumstat(raw);
  assert.deepStrictEqual(stats.get("abc"), {
    files: ["apps/web/src/app.ts"],
    added: 3,
    deleted: 1,
  });
});

it("builds the inventory with shared attribution from the net diffs", () => {
  const reverted = "c".repeat(40);
  const commits = [
    {
      sha: "a".repeat(40),
      short: "aaaaaaa",
      subject: "feat: one",
      domain: "fork-meta",
      tier: "qol",
    },
    {
      sha: reverted,
      short: "ccccccc",
      subject: "fix: two",
      domain: "fork-meta",
      tier: "core",
    },
  ];
  const statsBySha = new Map([
    ["a".repeat(40), { files: ["shared.ts", "fork-only.ts"], added: 5, deleted: 1 }],
    [reverted, { files: ["reverted.ts"], added: 2, deleted: 2 }],
  ]);
  const inventory = buildInventory({
    base: "base",
    head: "head",
    target: "upstream/main",
    commits,
    statsBySha,
    // reverted.ts is absent from the net fork diff: a later commit undid it.
    forkChanged: new Set(["shared.ts"]),
    upstreamChanged: new Set(["shared.ts", "reverted.ts"]),
  });
  assert.deepStrictEqual(inventory.domains, [
    {
      domain: "fork-meta",
      commits: 2,
      added: 7,
      deleted: 3,
      files: 3,
      overlaps: 1,
    },
  ]);
  assert.deepStrictEqual(inventory.commits, [
    {
      short: "aaaaaaa",
      domain: "fork-meta",
      tier: "qol",
      upstreamable: "",
      files: 2,
      overlaps: 1,
    },
    {
      short: "ccccccc",
      domain: "fork-meta",
      tier: "core",
      upstreamable: "",
      files: 1,
      overlaps: 0,
    },
  ]);
  const rendered = renderInventory(inventory);
  assert.include(rendered, "| Total | 2 | 7 | 3 | 3 | 1 |");
  assert.include(rendered, "# Fork delta inventory: `head` over `base` against `upstream/main`");
});

it("dedupes a domain's files across commits and counts distinct files in the total", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const commits = [
    { sha: shaA, short: "aaaaaaa", subject: "feat: one", domain: "fork-meta", tier: "qol" },
    { sha: shaB, short: "bbbbbbb", subject: "feat: two", domain: "fork-meta", tier: "core" },
    { sha: shaC, short: "ccccccc", subject: "feat: three", domain: "zmux-estate", tier: "core" },
  ];
  const statsBySha = new Map([
    [shaA, { files: ["shared.ts", "a.ts"], added: 5, deleted: 1 }],
    [shaB, { files: ["shared.ts", "b.ts"], added: 2, deleted: 0 }],
    [shaC, { files: ["shared.ts", "c.ts"], added: 1, deleted: 1 }],
  ]);
  const changed = new Set(["shared.ts", "a.ts", "b.ts", "c.ts"]);
  const inventory = buildInventory({
    base: "base",
    head: "head",
    target: "upstream/main",
    commits,
    statsBySha,
    forkChanged: changed,
    upstreamChanged: new Set(["shared.ts"]),
  });
  // shared.ts appears in both of fork-meta's commits but its Files cell counts it once.
  assert.deepStrictEqual(inventory.domains, [
    { domain: "fork-meta", commits: 2, added: 7, deleted: 1, files: 3, overlaps: 1 },
    { domain: "zmux-estate", commits: 1, added: 1, deleted: 1, files: 2, overlaps: 1 },
  ]);
  // The Total Files cell is the distinct count (4), not the per-domain sum (5).
  assert.strictEqual(inventory.distinctFiles, 4);
  const rendered = renderInventory(inventory);
  assert.include(rendered, "| Total | 3 | 8 | 2 | 4 | 2 |");
});

it("diverges per-commit and per-domain overlap when a domain's commits share a file", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const commits = [
    { sha: shaA, short: "aaaaaaa", subject: "feat: one", domain: "fork-meta", tier: "qol" },
    { sha: shaB, short: "bbbbbbb", subject: "feat: two", domain: "fork-meta", tier: "core" },
  ];
  const statsBySha = new Map([
    [shaA, { files: ["shared.ts"], added: 1, deleted: 0 }],
    [shaB, { files: ["shared.ts"], added: 0, deleted: 1 }],
  ]);
  const inventory = buildInventory({
    base: "base",
    head: "head",
    target: "upstream/main",
    commits,
    statsBySha,
    forkChanged: new Set(["shared.ts"]),
    upstreamChanged: new Set(["shared.ts"]),
  });
  // Each commit's own files overlap, but the domain's deduped file set overlaps once.
  assert.deepStrictEqual(
    inventory.commits.map((commit) => commit.overlaps),
    [1, 1],
  );
  assert.deepStrictEqual(
    inventory.domains.map((domain) => domain.overlaps),
    [1],
  );
});

// -- Inventory CLI -------------------------------------------------------------

const RETIREMENT_SECTIONS = [
  "## Retired",
  "",
  "| Fork commit | Domain | Upstream replacement | Retired at |",
  "| --- | --- | --- | --- |",
  "",
  "## Kept",
  "",
  "| Fork commit | Domain | Reason | Reviewed at |",
  "| --- | --- | --- | --- |",
  "",
].join("\n");

/**
 * A repo whose stack carries two fork-meta commits, one of them on a file upstream also changes.
 */
const createStackFixture = () => {
  const { root } = createGitFixture();
  const docs = NodePath.join(root, "docs/internals");
  NodeFS.mkdirSync(docs, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-delta.md"), RETIREMENT_SECTIONS);
  NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-wire-baseline.md"), "");
  git(root, ["add", "."]);
  const base = commitAll(root, "fixture: seed the fork stack");
  git(root, ["switch", "-c", "upstream"]);
  NodeFS.writeFileSync(NodePath.join(root, "shared.ts"), "upstream grew\n");
  const upstream = commitAll(root, "upstream: change the shared file");
  git(root, ["switch", "fixture"]);
  NodeFS.writeFileSync(NodePath.join(root, "shared.ts"), "fork line\n");
  NodeFS.writeFileSync(NodePath.join(root, "file1.ts"), "one\n");
  commitAll(root, "feat: fork change one", "Fork-Domain: fork-meta\nFork-Tier: qol\n");
  NodeFS.writeFileSync(NodePath.join(root, "file2.ts"), "two\n");
  commitAll(root, "feat: fork change two", "Fork-Domain: fork-meta\nFork-Tier: core\n");
  const head = git(root, ["rev-parse", "HEAD"]);
  return { root, base, upstream, head };
};

const runForkDelta = (
  root: string,
  args: ReadonlyArray<string>,
): { status: number; stdout: string; stderr: string } => {
  const result = NodeChildProcess.spawnSync(process.execPath, [forkDeltaScript, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const checkArgs = (base: string, head: string, upstream: string) => [
  "--check",
  "--base",
  base,
  "--head",
  head,
  "--upstream",
  upstream,
];

it("keeps --check green on a fully tagged stack", () => {
  const { root, base, upstream, head } = createStackFixture();
  try {
    const result = runForkDelta(root, checkArgs(base, head, upstream));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.include(result.stdout, "ok: 2 fork commits tagged");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("prints the inventory object with --json and refuses the ledger-only --base", () => {
  const { root, base, upstream, head } = createStackFixture();
  try {
    const json = runForkDelta(root, [
      "--inventory",
      "--json",
      "--head",
      head,
      "--upstream",
      upstream,
    ]);
    assert.strictEqual(json.status, 0, json.stderr);
    const inventory = JSON.parse(json.stdout) as {
      base: string;
      distinctFiles: number;
      domains: ReadonlyArray<{ domain: string; commits: number }>;
    };
    assert.strictEqual(inventory.base, base);
    assert.deepStrictEqual(
      inventory.domains.map((domain) => domain.domain),
      ["fork-meta"],
    );
    assert.strictEqual(inventory.domains[0]?.commits, 2);
    assert.strictEqual(inventory.distinctFiles, 3);

    const rejected = runForkDelta(root, [
      "--inventory",
      "--base",
      base,
      "--head",
      head,
      "--upstream",
      upstream,
    ]);
    assert.strictEqual(rejected.status, 2);
    assert.include(rejected.stderr, "--base is a ledger-only flag");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("excludes walk repair commits from the inventory sums", () => {
  const { root, base, upstream } = createStackFixture();
  try {
    NodeFS.writeFileSync(NodePath.join(root, "repair.ts"), "repair line one\nrepair line two\n");
    const withRepair = commitAll(
      root,
      "fix: repair the walk after a conflicted replay",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Repair: v0.0.39-fix\n",
    );
    const result = runForkDelta(root, checkArgs(base, withRepair, upstream));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.include(result.stdout, "ok: 3 fork commits tagged");

    const json = runForkDelta(root, [
      "--inventory",
      "--json",
      "--head",
      withRepair,
      "--upstream",
      upstream,
    ]);
    assert.strictEqual(json.status, 0, json.stderr);
    const inventory = JSON.parse(json.stdout) as {
      domains: ReadonlyArray<{
        domain: string;
        commits: number;
        added: number;
        deleted: number;
        files: number;
        overlaps: number;
      }>;
      commits: ReadonlyArray<{ short: string }>;
      distinctFiles: number;
    };
    // The repair commit's lines stay out of the sums and the distinct count
    // while its per-commit row remains visible.
    assert.deepStrictEqual(inventory.domains, [
      { domain: "fork-meta", commits: 2, added: 3, deleted: 0, files: 3, overlaps: 1 },
    ]);
    assert.strictEqual(inventory.commits.length, 3);
    assert.strictEqual(inventory.distinctFiles, 3);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
