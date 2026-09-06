// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { FORK_PR_TEMPLATE_PATH } from "./lib/fork-pr-template.ts";
import { parseForkRetirementLedger } from "./lib/fork-retirement-ledger.ts";
import { FORK_DOMAINS } from "./lib/fork-trailers.ts";
import {
  budgetFindings,
  budgetRaises,
  forkBudgetFindingMessage,
  forkBudgetRefusalMessage,
  parseForkBudget,
  renderForkBudget,
} from "./lib/fork-budget.ts";
import {
  buildInventory,
  buildLedger,
  buildSquashLedger,
  collectWireShapeFindings,
  collectWireShapeFindingsBetween,
  collectFindings,
  forkLogArguments,
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

const record = (short: string, subject: string, trailers: string) =>
  `${short.padEnd(40, "0")}${FS}${short}${FS}${subject}${FS}${trailers}${RS}\n`;

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
    subject: "fix(web): scope markdown actions",
    domain: "project-windows",
    tier: "bugfix",
    upstreamable: "yes",
  });
  assert.deepStrictEqual(commits[3], {
    sha: "ddddddddd".padEnd(40, "0"),
    short: "ddddddddd",
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

it("accepts a walk repair commit the sync appended after the replayed series", () => {
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

// -- Fork budget ---------------------------------------------------------------

const seededBudget = (rows: ReadonlyArray<string>): string =>
  [
    "# Fork budget",
    "",
    "| Domain | Commits | Added | Deleted | Shared |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((cells) => `| ${cells} |`),
    "",
  ].join("\n");

it("round-trips the budget through its renderer", () => {
  const markdown = renderForkBudget({
    rows: [{ domain: "fork-meta", commits: 2, added: 10, deleted: 4, overlaps: 1 }],
  });
  const budget = parseForkBudget(markdown);
  assert.deepStrictEqual(budget.unknownDomains, []);
  assert.deepStrictEqual(budget.rows.get("fork-meta"), {
    domain: "fork-meta",
    commits: 2,
    added: 10,
    deleted: 4,
    shared: 1,
  });
});

it("flags budget rows outside the fork domains without enforcing them", () => {
  const budget = parseForkBudget(
    renderForkBudget({
      rows: [{ domain: "not-a-domain", commits: 0, added: 0, deleted: 0, overlaps: 0 }],
    }),
  );
  assert.deepStrictEqual(budget.unknownDomains, ["not-a-domain"]);
});

it("rejects a malformed budget table instead of guessing ceilings", () => {
  const good = renderForkBudget({
    rows: [{ domain: "fork-meta", commits: 1, added: 2, deleted: 3, overlaps: 4 }],
  });
  assert.throws(() => parseForkBudget(good.replace("| Shared |", "| |")), /unexpected header/);
  assert.throws(
    () =>
      parseForkBudget(
        renderForkBudget({
          rows: [
            { domain: "fork-meta", commits: 1, added: 2, deleted: 3, overlaps: 4 },
            { domain: "fork-meta", commits: 1, added: 2, deleted: 3, overlaps: 4 },
          ],
        }),
      ),
    /duplicate domain: fork-meta/,
  );
  assert.throws(
    () => parseForkBudget(good.replace("| fork-meta | 1 |", "| fork-meta | x |")),
    /non-integer Commits cell: x/,
  );
  assert.throws(() => parseForkBudget("no table at all"), /missing/);
});

it("fails a stack over a gated ceiling, naming the domain and both numbers", () => {
  const budget = parseForkBudget(
    renderForkBudget({
      rows: [{ domain: "fork-meta", commits: 2, added: 10, deleted: 4, overlaps: 1 }],
    }),
  );
  const findings = budgetFindings(
    [{ domain: "fork-meta", commits: 9, added: 11, deleted: 4, overlaps: 2 }],
    budget,
  );
  assert.deepStrictEqual(findings.map(forkBudgetFindingMessage), [
    "fork-meta: added 11 > 10 ceiling",
  ]);
  // At a ceiling is still under it: the ceiling is the inclusive maximum.
  assert.deepStrictEqual(
    budgetFindings(
      [{ domain: "fork-meta", commits: 9, added: 10, deleted: 4, overlaps: 1 }],
      budget,
    ),
    [],
  );
});

it("records commit counts and shared attributions without gating on them", () => {
  const budget = parseForkBudget(
    renderForkBudget({
      rows: [{ domain: "fork-meta", commits: 2, added: 10, deleted: 4, overlaps: 1 }],
    }),
  );
  // Nine commits and five shared files over the recorded numbers are not
  // findings: a commit count is not a cost, and shared attribution moves with
  // every upstream tag even when the fork does not.
  assert.deepStrictEqual(
    budgetFindings(
      [{ domain: "fork-meta", commits: 9, added: 10, deleted: 4, overlaps: 5 }],
      budget,
    ),
    [],
  );
});

it("fails a domain without a budget row closed at ceiling zero", () => {
  const findings = budgetFindings(
    [{ domain: "zmux-estate", commits: 1, added: 1, deleted: 0, overlaps: 0 }],
    { rows: new Map(), unknownDomains: [] },
  );
  assert.deepStrictEqual(findings.map(forkBudgetFindingMessage), [
    "zmux-estate: added 1 > 0 ceiling (domain has no budget row)",
  ]);
  // The refusal adds the overage and the exact raise route.
  assert.deepStrictEqual(findings.map(forkBudgetRefusalMessage), [
    "zmux-estate: added 1 > 0 ceiling (domain has no budget row) (over by 1) — to raise it: edit docs/internals/fork-budget.md to set the zmux-estate added ceiling to at least 1, and carry Fork-Budget: raise <reason> on that commit",
  ]);
});

it("detects exactly the gated numbers a commit pushed up", () => {
  const before = seededBudget(["fork-meta | 2 | 10 | 4 | 1"]);
  // Raises on every gated measure.
  assert.deepStrictEqual(budgetRaises(before, seededBudget(["fork-meta | 9 | 11 | 5 | 2"])), [
    { domain: "fork-meta", measure: "added", from: 10, to: 11 },
    { domain: "fork-meta", measure: "deleted", from: 4, to: 5 },
  ]);
  // Raising the recorded commit count or the shared attribution alone is not a
  // budget increase.
  assert.deepStrictEqual(budgetRaises(before, seededBudget(["fork-meta | 9 | 10 | 4 | 9"])), []);
  // Lowering or holding is never a raise.
  assert.deepStrictEqual(budgetRaises(before, seededBudget(["fork-meta | 1 | 3 | 2 | 0"])), []);
  // The initial seed is not a raise: there is no prior baseline to raise from.
  assert.deepStrictEqual(budgetRaises(undefined, seededBudget(["fork-meta | 2 | 10 | 4 | 1"])), []);
});

it("validates the Fork-Budget raise trailer shape", () => {
  const findings = collectFindings([
    parseSquashBody(
      "seeded",
      "feat: seed\n\nFork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise seed the budget\n",
    ),
    parseSquashBody(
      "reasonless",
      "feat: raise\n\nFork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise\n",
    ),
    parseSquashBody(
      "wrong-verb",
      "feat: raise\n\nFork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: reviewed fixture\n",
    ),
  ]);
  assert.deepStrictEqual(
    findings.map((finding) => finding.problem),
    ['Fork-Budget must be "raise <reason>"', 'Fork-Budget must be "raise <reason>"'],
  );
});

// -- Fork budget CLI -----------------------------------------------------------

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
 * With a budget string the file is part of the base commit (the initial seed carries no raise
 * trailer); with null the stack never seeded a baseline, so ceiling tests see the skip path.
 */
const createBudgetFixture = (budget: string | null) => {
  const { root } = createGitFixture();
  const docs = NodePath.join(root, "docs/internals");
  NodeFS.mkdirSync(docs, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-delta.md"), RETIREMENT_SECTIONS);
  NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-wire-baseline.md"), "");
  if (budget !== null) NodeFS.writeFileSync(NodePath.join(docs, "fork-budget.md"), budget);
  git(root, ["add", "."]);
  const base = commitAll(root, "fixture: seed the budget");
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

const budgetFile = (added: number, deleted: number, shared: number): string =>
  renderForkBudget({
    rows: [{ domain: "fork-meta", commits: 2, added, deleted, overlaps: shared }],
  });

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

it("fails --check on a stack over a gated ceiling, naming the domain, overage, and raise route", () => {
  const { root, base, upstream, head } = createBudgetFixture(budgetFile(2, 0, 1));
  try {
    const result = runForkDelta(root, checkArgs(base, head, upstream));
    assert.strictEqual(result.status, 1);
    assert.include(result.stderr, "over budget: fork-meta: added 3 > 2 ceiling");
    // The refusal is actionable: it names the overage and the exact raise route.
    assert.include(result.stderr, "(over by 1)");
    assert.include(
      result.stderr,
      "edit docs/internals/fork-budget.md to set the fork-meta added ceiling to at least 3",
    );
    assert.include(result.stderr, "carry Fork-Budget: raise <reason> on that commit");
    assert.include(
      result.stderr,
      "failed: 1 fork budget ceiling(s) exceeded (docs/internals/fork-budget.md)",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps --check green when the stack sits at or under the ceilings", () => {
  const { root, base, upstream, head } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    const result = runForkDelta(root, checkArgs(base, head, upstream));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.include(result.stdout, "ok: 2 fork commits tagged");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("skips the budget while the stack never seeded a baseline", () => {
  const { root, base, upstream, head } = createBudgetFixture(null);
  try {
    const result = runForkDelta(root, checkArgs(base, head, upstream));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.include(result.stdout, "ok: 2 fork commits tagged");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a working tree that dropped an established baseline", () => {
  const { root, base, upstream, head } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.rmSync(NodePath.join(root, "docs/internals/fork-budget.md"), { force: true });
    const result = runForkDelta(root, checkArgs(base, head, upstream));
    assert.strictEqual(result.status, 1);
    assert.include(result.stderr, "is removed from the stack");
    assert.include(result.stderr, "the budget never ratchets to absent");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a commit that deletes an established baseline, even with a raise trailer", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.rmSync(NodePath.join(root, "docs/internals/fork-budget.md"), { force: true });
    git(root, ["add", "."]);
    const removing = commitAll(
      root,
      "chore: drop the budget baseline",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise removing the baseline\n",
    );
    const result = runForkDelta(root, checkArgs(base, removing, upstream));
    assert.strictEqual(result.status, 1);
    assert.include(
      result.stderr,
      `removes docs/internals/fork-budget.md; the budget never ratchets to absent`,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a squash that deletes an established baseline", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.rmSync(NodePath.join(root, "docs/internals/fork-budget.md"), { force: true });
    git(root, ["add", "."]);
    const removing = commitAll(
      root,
      "chore: drop the budget baseline",
      "Fork-Domain: fork-meta\nFork-Tier: qol\n",
    );
    const bodyPath = NodePath.join(root, "pr-body.md");
    NodeFS.writeFileSync(
      bodyPath,
      "feat: the fork stack\n\nFork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise removing the baseline\n",
    );
    const result = runForkDelta(root, [
      "--check",
      "--base",
      base,
      "--head",
      removing,
      "--upstream",
      upstream,
      "--squash-body",
      bodyPath,
    ]);
    assert.strictEqual(result.status, 1);
    assert.include(result.stderr, "pull-request body: removes docs/internals/fork-budget.md");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("seeds a baseline that survives its own commit: seed, commit, check green", () => {
  const { root, base, upstream } = createBudgetFixture(null);
  try {
    const seed = runForkDelta(root, ["--seed-budget", "--upstream", upstream]);
    assert.strictEqual(seed.status, 0, seed.stderr);
    assert.include(seed.stdout, "fork-meta Added carries the table's own lines");
    const seeded = parseForkBudget(
      NodeFS.readFileSync(NodePath.join(root, "docs/internals/fork-budget.md"), "utf8"),
    ).rows.get("fork-meta");
    // The stack's own added lines are 3; the seeded ceiling carries the
    // table's own lines on top, so landing the file stays inside the ceiling.
    assert.ok((seeded?.added ?? 0) > 3, `expected headroom, got ${seeded?.added}`);
    git(root, ["add", "."]);
    const seededHead = commitAll(
      root,
      "chore: seed the fork budget",
      "Fork-Domain: fork-meta\nFork-Tier: qol\n",
    );
    const result = runForkDelta(root, checkArgs(base, seededHead, upstream));
    assert.strictEqual(result.status, 0, result.stderr);
    assert.include(result.stdout, "ok: 3 fork commits tagged");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("fails a raising commit that carries no Fork-Budget raise trailer", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    // The raising commit doubles the added-line ceiling without a trailer.
    NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-budget.md"), budgetFile(6, 1, 1));
    git(root, ["add", "."]);
    const raising = commitAll(
      root,
      "feat: raise the added ceiling",
      "Fork-Domain: fork-meta\nFork-Tier: qol\n",
    );
    const withoutTrailer = runForkDelta(root, checkArgs(base, raising, upstream));
    assert.strictEqual(withoutTrailer.status, 1);
    assert.include(
      withoutTrailer.stderr,
      `raises fork-meta added 3 -> 6 without Fork-Budget: raise <reason>`,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a raised ceiling when the raising commit carries the trailer, and the raise is visible", () => {
  const { root, base, upstream, head } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-budget.md"), budgetFile(6, 1, 1));
    git(root, ["add", "."]);
    const raising = commitAll(
      root,
      "feat: raise the added ceiling",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise the shared-file module grew\n",
    );
    const withTrailer = runForkDelta(root, checkArgs(base, raising, upstream));
    assert.strictEqual(withTrailer.status, 0, withTrailer.stderr);
    // The raise is never silent: the gate echoes it with the numbers and the reason.
    assert.include(withTrailer.stdout, "budget raise: fork-meta added 3 -> 6");
    assert.include(withTrailer.stdout, "raise the shared-file module grew");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a raising commit whose Fork-Budget trailer has no reason", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-budget.md"), budgetFile(6, 1, 1));
    git(root, ["add", "."]);
    const reasonless = commitAll(
      root,
      "feat: raise the added ceiling",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise\n",
    );
    const result = runForkDelta(root, checkArgs(base, reasonless, upstream));
    assert.strictEqual(result.status, 1);
    assert.include(
      result.stderr,
      `raises fork-meta added 3 -> 6 without Fork-Budget: raise <reason>`,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a raising commit whose Fork-Budget reason is only whitespace", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-budget.md"), budgetFile(6, 1, 1));
    git(root, ["add", "."]);
    const blankReason = commitAll(
      root,
      "feat: raise the added ceiling",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise    \n",
    );
    const result = runForkDelta(root, checkArgs(base, blankReason, upstream));
    assert.strictEqual(result.status, 1);
    assert.include(
      result.stderr,
      `raises fork-meta added 3 -> 6 without Fork-Budget: raise <reason>`,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a lowered ceiling green without any trailer", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-budget.md"), budgetFile(1, 1, 1));
    git(root, ["add", "."]);
    const lowering = commitAll(
      root,
      "chore: tighten the added ceiling",
      "Fork-Domain: fork-meta\nFork-Tier: qol\n",
    );
    const lowered = runForkDelta(root, checkArgs(base, lowering, upstream));
    assert.strictEqual(lowered.status, 1);
    // The lower ceiling is enforced immediately: the stack is over it now (the
    // lowering commit's own edit of the table counts toward the domain, too).
    assert.include(lowered.stderr, "over budget: fork-meta: added 4 > 1 ceiling");
    assert.notInclude(lowered.stderr, "without Fork-Budget");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("seeds the budget from the live inventory and refuses conflicting mode flags", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    const combined = runForkDelta(root, ["--seed-budget", "--check", "--base", base]);
    assert.strictEqual(combined.status, 2);
    assert.include(combined.stderr, "--seed-budget takes no other mode flags");

    const result = runForkDelta(root, ["--seed-budget", "--upstream", upstream]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.include(result.stdout, `ok: docs/internals/fork-budget.md seeded for 1 domains`);
    assert.include(result.stdout, "fork-meta Added carries the table's own lines");
    assert.include(result.stdout, "the initial seed carries no Fork-Budget raise trailer");
    const markdown = NodeFS.readFileSync(
      NodePath.join(root, "docs/internals/fork-budget.md"),
      "utf8",
    );
    // The table's own lines land in fork-meta's Added ceiling so the seeding
    // commit stays inside the ceiling it just wrote.
    assert.deepStrictEqual(parseForkBudget(markdown).rows.get("fork-meta"), {
      domain: "fork-meta",
      commits: 2,
      added: 3 + markdown.split("\n").length - 1,
      deleted: 0,
      shared: 1,
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("prints the inventory object with --json and refuses the ledger-only --base", () => {
  const { root, base, upstream, head } = createBudgetFixture(budgetFile(3, 1, 1));
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

it("excludes walk repair commits from the budget line sums", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    // An unattended walk repair cannot author a raise trailer: its lines are
    // the walk's own bookkeeping, not a domain's change.
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

it("fails a squash body that raises a ceiling without the Fork-Budget trailer", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-budget.md"), budgetFile(6, 1, 1));
    git(root, ["add", "."]);
    const raising = commitAll(
      root,
      "feat: raise the added ceiling",
      "Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise the shared-file module grew\n",
    );
    const bodyPath = NodePath.join(root, "pr-body.md");
    NodeFS.writeFileSync(
      bodyPath,
      "feat: the fork stack\n\nFork-Domain: fork-meta\nFork-Tier: qol\n",
    );
    const result = runForkDelta(root, [
      "--check",
      "--base",
      base,
      "--head",
      raising,
      "--upstream",
      upstream,
      "--squash-body",
      bodyPath,
    ]);
    assert.strictEqual(result.status, 1);
    assert.include(
      result.stderr,
      "pull-request body: raises fork-meta added 3 -> 6 without Fork-Budget: raise <reason>",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a squash that raises a ceiling when the body carries the trailer", () => {
  const { root, base, upstream } = createBudgetFixture(budgetFile(3, 1, 1));
  try {
    NodeFS.writeFileSync(NodePath.join(root, "docs/internals/fork-budget.md"), budgetFile(6, 1, 1));
    git(root, ["add", "."]);
    const raising = commitAll(
      root,
      "feat: raise the added ceiling",
      "Fork-Domain: fork-meta\nFork-Tier: qol\n",
    );
    const bodyPath = NodePath.join(root, "pr-body.md");
    NodeFS.writeFileSync(
      bodyPath,
      "feat: the fork stack\n\nFork-Domain: fork-meta\nFork-Tier: qol\nFork-Budget: raise the shared-file module grew\n",
    );
    const result = runForkDelta(root, [
      "--check",
      "--base",
      base,
      "--head",
      raising,
      "--upstream",
      upstream,
      "--squash-body",
      bodyPath,
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
