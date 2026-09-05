// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseForkRetirementLedger } from "./lib/fork-retirement-ledger.ts";
import {
  buildLedger,
  buildSquashLedger,
  collectWireShapeFindings,
  collectWireShapeFindingsBetween,
  collectFindings,
  forkLogArguments,
  parseForkLog,
  parseSquashBody,
  readForkLog,
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
