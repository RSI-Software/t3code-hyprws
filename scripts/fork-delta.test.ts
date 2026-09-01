import { assert, it } from "@effect/vitest";

import { parseForkRetirementLedger } from "./lib/fork-retirement-ledger.ts";
import {
  buildLedger,
  collectFindings,
  forkLogArguments,
  parseForkLog,
  parseSquashBody,
  renderMarkdown,
  renderShas,
  selectDomain,
  squashTrailers,
} from "./fork-delta.ts";

const RS = "";
const FS = "";

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
