// @effect-diagnostics nodeBuiltinImport:off - The create path reads a reviewed draft from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  differenceRows,
  execute,
  firstParagraph,
  legacyUatTasks,
  parseArgs,
  partitionUatRows,
  relationshipArguments,
  renderUatBody,
  readPreviousUat,
  reviewedDraft,
  resolvePreviousStable,
  selectPreviousStable,
  targetVersionFromUpstreamTag,
  uatTitle,
  type CommandRunner,
  type ForkCommit,
} from "./fork-uat.ts";

const commit = (sha: string, subject: string, domain = "project-windows"): ForkCommit => ({
  sha,
  short: sha.slice(0, 7),
  subject,
  domain,
  tier: "qol",
});

const stableTags = [
  "v1.2.9-hyprws.4",
  "v1.3.0-hyprws.1",
  "v1.3.0-hyprws.12",
  "v1.4.0-hyprws.1",
  "v1.4.0-hyprws.2",
  "v1.5.0-hyprws.1",
  "v1.4.0-hyprws-nightly.20260830.1",
];

it("selects the highest stable at or below the ref's upstream version", () => {
  assert.strictEqual(selectPreviousStable([1, 4, 0], stableTags), "v1.4.0-hyprws.2");
  assert.strictEqual(selectPreviousStable([1, 3, 5], stableTags), "v1.3.0-hyprws.12");
  assert.isNull(selectPreviousStable([1, 2, 0], stableTags));
});

it("selects the next stable down when the ref itself carries a stable tag", () => {
  assert.strictEqual(
    selectPreviousStable([1, 4, 0], stableTags, ["v1.4.0-hyprws.2"]),
    "v1.4.0-hyprws.1",
  );
  assert.strictEqual(
    selectPreviousStable([1, 4, 0], stableTags, ["v1.4.0-hyprws.1"]),
    "v1.3.0-hyprws.12",
  );
});

it("derives the target version from nightly and stable upstream base tags", () => {
  assert.strictEqual(targetVersionFromUpstreamTag("v1.4.0-nightly.20260830.1217"), "v1.4.0-hyprws");
  assert.strictEqual(targetVersionFromUpstreamTag("v1.5.2"), "v1.5.2-hyprws");
  assert.throws(() => targetVersionFromUpstreamTag("v1.5.2-rc.1"), /unsupported/);
  assert.throws(() => targetVersionFromUpstreamTag("v1.5.2-nightly.99999999.1"), /unsupported/);
});

it("keys the UAT title on the target version", () => {
  assert.strictEqual(uatTitle("v1.4.0-hyprws"), "UAT v1.4.0-hyprws");
});

it("accepts a valid target version override and refuses invalid values", () => {
  assert.strictEqual(parseArgs(["--version", "v2.3.4-hyprws"]).version, "v2.3.4-hyprws");
  assert.throws(() => parseArgs(["--version", "2.3.4-hyprws"]), /must match/);
  assert.throws(() => parseArgs(["--version", "v2.3.4-hyprws.1"]), /must match/);
});

it("accepts an existing stable --since override and refuses other tags", () => {
  const runner: CommandRunner = {
    run: (_command, args) => ({
      status: args.at(-1) === "refs/tags/v1.3.0-hyprws.12" ? 0 : 1,
      stdout: "",
      stderr: "",
    }),
  };
  const since = parseArgs(["--since", "v1.3.0-hyprws.12"]).since;

  assert.deepStrictEqual(resolvePreviousStable(runner, since, [1, 4, 0], stableTags, []), {
    tag: "v1.3.0-hyprws.12",
    overridden: true,
  });
  assert.throws(
    () => resolvePreviousStable(runner, "v1.4.0-hyprws.9", [1, 4, 0], stableTags, []),
    /does not exist/,
  );
  assert.throws(() => parseArgs(["--since", "v1.3.0-hyprws"]), /must match/);
  assert.throws(() => parseArgs(["--since", "v1.3.0-hyprws-nightly.1"]), /must match/);
  assert.throws(() => parseArgs(["--since", "v1.3.0-hyprws.0"]), /must match/);
});

it("reduces a multiline PR body to its first paragraph", () => {
  assert.strictEqual(
    firstParagraph("First line\ncontinues here.\n\nSecond paragraph."),
    "First line continues here.",
  );
});

it("uses an explicit related issue or declares no relationship", () => {
  assert.deepStrictEqual(relationshipArguments(null), ["--no-relationship"]);
  assert.deepStrictEqual(relationshipArguments(321), [
    "--relates-to",
    "RSI-Software/t3code-hyprws#321",
  ]);
});

it("diffs by exact subject before falling back to mocked stable patch IDs", () => {
  const previous = [
    commit("old-subject", "Keep the same subject"),
    commit("old-patch", "Old wording"),
  ];
  const current = [
    commit("new-subject", "Keep the same subject"),
    commit("new-patch", "Reworded after rebase"),
    commit("new-row", "Visible new behavior"),
    commit("new-empty", "Patchless visible behavior"),
  ];
  const patchIds = new Map([
    ["old-subject", "patch-subject"],
    ["old-patch", "shared-patch"],
    ["new-subject", "different-patch"],
    ["new-patch", "shared-patch"],
    ["new-row", "new-patch"],
  ]);
  const paths = new Map([
    ["new-row", ["apps/web/src/new-row.ts"]],
    ["new-empty", ["apps/web/src/patchless.ts"]],
  ]);

  const rows = differenceRows(
    current,
    previous,
    (sha) => patchIds.get(sha) ?? null,
    (sha) => paths.get(sha) ?? [],
  );

  assert.deepStrictEqual(
    rows.map((row) => ({ sha: row.sha, patchId: row.patchId, paths: row.paths })),
    [
      { sha: "new-row", patchId: "new-patch", paths: ["apps/web/src/new-row.ts"] },
      { sha: "new-empty", patchId: null, paths: ["apps/web/src/patchless.ts"] },
    ],
  );
});

it("keeps only the product commit after applying each exclusion rule in order", () => {
  const row = (sha: string, subject: string, domain: string, paths: ReadonlyArray<string>) => ({
    ...commit(sha, subject, domain),
    paths,
    patchId: `patch-${sha}`,
  });
  const result = partitionUatRows([
    row("product", "fix(web): keep visible behavior", "thread-ordering", ["apps/web/src/index.ts"]),
    row("domain", "fix(web): supporting lifecycle", "fork-meta", ["apps/web/src/meta.ts"]),
    row("type", "chore(web): reorganize support", "thread-ordering", ["apps/web/src/support.ts"]),
    row("paths", "fix(web): refresh support files", "thread-ordering", [
      ".github/workflows/ci.yml",
      "scripts/release.ts",
      "docs/operations/release.md",
      ".agents/skills/release/SKILL.md",
      "apps/web/src/release.test.ts",
      "apps/web/package.json",
      "pnpm-lock.yaml",
    ]),
  ]);

  assert.deepStrictEqual(
    result.rows.map((entry) => entry.sha),
    ["product"],
  );
  assert.deepStrictEqual(
    result.excluded.map((entry) => entry.reason),
    ["fork-meta", "conventional", "supporting-paths"],
  );
});

it("renders sources and carries prior acceptance into fresh task drafts", () => {
  const body = renderUatBody({
    ref: "origin/release/v1.4.0-hyprws",
    sha: "a".repeat(40),
    targetVersion: "v1.4.0-hyprws",
    upstreamBaseTag: "v1.4.0",
    upstreamBaseSha: "b".repeat(40),
    previousStable: "v1.3.0-hyprws.12",
    previousStableOverridden: true,
    relatesTo: 321,
    previousUat: {
      issue: 245,
      url: "https://github.com/RSI-Software/t3code-hyprws/issues/245",
      tasks: [
        {
          area: "Sidebar",
          title: "Threads accept manual ordering",
          carriedFrom: [{ issue: 245, status: "accepted" }],
        },
        {
          area: "Sidebar",
          title: "Groups remain usable automatically",
          carriedFrom: [{ issue: 245, status: "unsettled" }],
        },
      ],
    },
    sources: [
      {
        short: "7654321",
        subject: "feat(web): open projects directly (#321)",
        prBody: "Projects open without an intermediate dialog.",
      },
      { short: "abcdef0", subject: "fix(web): keep bookmarks visible", prBody: null },
    ],
    excluded: [{ short: "1234567", subject: "ci(fork): publish support", reason: "fork-meta" }],
  });

  assert.strictEqual(body.match(/^Origin:/gm)?.length, 1);
  assert.include(body, "Related issue: `RSI-Software/t3code-hyprws#321`.");
  assert.include(body, "- Target: `v1.4.0-hyprws`");
  assert.include(body, "- Ref: `origin/release/v1.4.0-hyprws`");
  assert.include(body, "- Previous stable: `v1.3.0-hyprws.12` (overridden)");
  assert.include(body, "## Sources");
  assert.include(body, "Included product commits (2)");
  assert.include(
    body,
    "`7654321` feat(web): open projects directly (#321) — Projects open without an intermediate dialog.",
  );
  assert.include(body, "`abcdef0` fix(web): keep bookmarks visible");
  assert.include(body, "## UAT\n\n<!-- fork-uat:task-drafts:v1 -->");
  assert.include(
    body,
    "- [ ] Threads accept manual ordering <!-- fork-uat:carried-from #245 accepted -->",
  );
  assert.include(
    body,
    "- [ ] Groups remain usable automatically <!-- fork-uat:carried-from #245 unsettled -->",
  );
  assert.include(body, "## Excluded");
  assert.include(body, "<details>");
  assert.include(body, "`1234567` ci(fork): publish support — Fork-Domain fork-meta");
  assert.include(body, "## Close condition");
  assert.include(body, "open children remain non-blocking evidence");
});

it("recovers legacy accepted and unsettled conditions without sign-off rows", () => {
  const tasks = legacyUatTasks(
    `## Close condition\n\n### Sidebar\n\n- [x] Threads accept manual ordering\n- [ ] Groups remain usable ([notes](https://example.test))\n\n### Sign-off\n\n- [ ] Every UAT row above is ticked or fixed\n- [ ] \`v1.2.3-hyprws.1\` is tagged\n`,
    245,
  );
  assert.deepStrictEqual(tasks, [
    {
      area: "Sidebar",
      title: "Threads accept manual ordering",
      carriedFrom: [{ issue: 245, status: "accepted" }],
    },
    {
      area: "Sidebar",
      title: "Groups remain usable",
      carriedFrom: [{ issue: 245, status: "unsettled" }],
    },
  ]);
});

it("separates review, preparation, and approved bundle creation", () => {
  assert.throws(() => parseArgs(["--prepare"]), /--prepare requires --body/);
  assert.throws(() => parseArgs(["--create"]), /--create requires --bundle/);
  assert.deepStrictEqual(parseArgs(["--prepare", "--body", "draft.md"]), {
    ref: "hyprws",
    version: null,
    since: null,
    relatesTo: null,
    output: null,
    body: "draft.md",
    bundle: null,
    prepare: true,
    create: false,
    humanApproved: false,
  });
  const metadata = `## Snapshot\n\n- Target: \`v1.4.0-hyprws\`\n- Ref: \`hyprws\`\n- Commit: \`${"a".repeat(40)}\``;
  assert.throws(
    () =>
      reviewedDraft(
        `${metadata}\n\n## Sources\n\nRaw material\n\n## UAT\n\n<!-- fork-uat:task-drafts:v1 -->\n\n- [ ] Test behavior\n`,
      ),
    /still contains ## Sources/,
  );
  assert.throws(
    () =>
      reviewedDraft(
        `${metadata}\n\n## UAT\n\n<!-- fork-uat:task-drafts:v1 -->\n\n- [ ] Test behavior\n\n## Excluded\n`,
      ),
    /still contains ## Excluded/,
  );
  assert.throws(
    () =>
      reviewedDraft(
        `${metadata}\n\n- [ ] Checkbox outside UAT\n\n## UAT\n\n<!-- fork-uat:task-drafts:v1 -->\n\nNo rows\n`,
      ),
    /no unchecked UAT rows/,
  );
  assert.throws(
    () =>
      reviewedDraft(
        `${metadata}\n\n## UAT\n\n<!-- fork-uat:task-drafts:v1 -->\n\n- [ ] Test behavior\n`,
      ),
    /row has no feature heading/,
  );
  assert.deepStrictEqual(
    reviewedDraft(
      `Related issue: \`RSI-Software/t3code-hyprws#321\`.\n\n## Snapshot\n\n- Target: \`v1.4.0-hyprws\`\n- Ref: \`hyprws\`\n- Commit: \`${"a".repeat(40)}\`\n\n## UAT\n\n<!-- fork-uat:task-drafts:v1 -->\n\n### Project windows\n\n- [ ] Projects open in separate windows\n`,
    ),
    {
      ref: "hyprws",
      sha: "a".repeat(40),
      targetVersion: "v1.4.0-hyprws",
      relatesTo: 321,
      tasks: [
        {
          area: "Project windows",
          title: "Projects open in separate windows",
          carriedFrom: [],
        },
      ],
    },
  );
});

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  private readonly responses = new Map<
    string,
    { status: number; stdout: string; stderr: string }
  >();
  private nextIssue = 900;

  set(key: string, result: Partial<{ status: number; stdout: string; stderr: string }>): void {
    this.responses.set(key, { status: 0, stdout: "", stderr: "", ...result });
  }

  run(command: string, args: ReadonlyArray<string>) {
    this.calls.push({ command, args });
    const result = this.responses.get(`${command} ${args.join(" ")}`) ?? {
      status: 0,
      stdout: "",
      stderr: "",
    };
    const json = args.indexOf("--json");
    if (command === "ghb" && result.status === 0 && json !== -1 && !args.includes("--dry-run")) {
      const path = args[json + 1];
      if (path !== undefined) {
        const number = this.nextIssue++;
        NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
        NodeFS.writeFileSync(
          path,
          `${JSON.stringify({
            phase: "complete",
            issue: {
              number,
              url: `https://github.com/RSI-Software/t3code-hyprws/issues/${number}`,
            },
          })}\n`,
        );
      }
    }
    return result;
  }
}

const uatListArgs = (targetVersion: string) => [
  "issue",
  "list",
  "--repo",
  "RSI-Software/t3code-hyprws",
  "--state",
  "all",
  "--label",
  "release",
  "--search",
  `"UAT ${targetVersion}" in:title`,
  "--limit",
  "1000",
  "--json",
  "number,title,body,url",
];

it("reads legacy UAT rows for the previous stable", () => {
  const runner = new RecordingRunner();
  runner.set(`gh ${uatListArgs("v0.0.36-hyprws").join(" ")}`, {
    stdout: JSON.stringify([
      {
        number: 245,
        title: "[📍] UAT v0.0.36-hyprws",
        body: "## Close condition\n\n### Sidebar\n\n- [x] Manual ordering works\n- [ ] Automatic groups remain usable\n",
        url: "https://github.com/RSI-Software/t3code-hyprws/issues/245",
      },
    ]),
  });

  assert.deepStrictEqual(readPreviousUat(runner, "v0.0.36-hyprws.1"), {
    issue: 245,
    url: "https://github.com/RSI-Software/t3code-hyprws/issues/245",
    tasks: [
      {
        area: "Sidebar",
        title: "Manual ordering works",
        carriedFrom: [{ issue: 245, status: "accepted" }],
      },
      {
        area: "Sidebar",
        title: "Automatic groups remain usable",
        carriedFrom: [{ issue: 245, status: "unsettled" }],
      },
    ],
  });
});

it("uses child state as the authority for a structured previous UAT", () => {
  const runner = new RecordingRunner();
  runner.set(`gh ${uatListArgs("v0.0.38-hyprws").join(" ")}`, {
    stdout: JSON.stringify([
      {
        number: 516,
        title: "UAT v0.0.38-hyprws [📥]",
        body: "## Acceptance\n\n<!-- fork-uat:subissues:v1 -->",
        url: "https://github.com/RSI-Software/t3code-hyprws/issues/516",
      },
    ]),
  });
  runner.set("gh issue view 516 --repo RSI-Software/t3code-hyprws --json subIssues", {
    stdout: JSON.stringify({
      subIssues: {
        nodes: [
          {
            number: 517,
            title: "UAT v0.0.38-hyprws: Sidebar — Manual ordering works [📡#516]",
            state: "CLOSED",
            url: "https://github.com/RSI-Software/t3code-hyprws/issues/517",
          },
          {
            number: 518,
            title: "[📡#516] UAT v0.0.38-hyprws: Sidebar — Automatic groups remain usable",
            state: "OPEN",
            url: "https://github.com/RSI-Software/t3code-hyprws/issues/518",
          },
        ],
      },
    }),
  });

  assert.deepStrictEqual(
    readPreviousUat(runner, "v0.0.38-hyprws.1")?.tasks.map((task) => ({
      area: task.area,
      title: task.title,
      status: task.carriedFrom[0]?.status,
    })),
    [
      { area: "Sidebar", title: "Manual ordering works", status: "accepted" },
      { area: "Sidebar", title: "Automatic groups remain usable", status: "unsettled" },
    ],
  );
});

it("preflights a tracker bundle and creates ordered acceptance children", () => {
  assert.isTrue(parseArgs(["--create", "--bundle", "bundle", "--human-approved"]).humanApproved);
  assert.throws(() => parseArgs(["--human-approved"]), /--human-approved requires --create/);
  const sha = "a".repeat(40);
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-uat-create-"));
  const draft = NodePath.join(root, "uat.md");
  const bundle = NodePath.join(root, "bundle");
  NodeFS.writeFileSync(
    draft,
    `Related issue: \`RSI-Software/t3code-hyprws#321\`.\n\n## Snapshot\n\n- Target: \`v1.4.0-hyprws\`\n- Ref: \`origin/release/v1.4.0-hyprws\`\n- Commit: \`${sha}\`\n\n## UAT\n\n<!-- fork-uat:task-drafts:v1 -->\n\n### Project windows\n\n- [ ] Projects open in separate windows\n- [ ] Closing a window keeps the hub\n\n## Close condition\n\nClose every acceptance child after it passes.\n`,
  );
  const runner = new RecordingRunner();
  runner.set("git rev-parse origin/release/v1.4.0-hyprws^{commit}", { stdout: `${sha}\n` });

  execute(parseArgs(["--prepare", "--body", draft, "--bundle", bundle]), runner);
  const preflights = runner.calls.filter(
    ({ command, args }) => command === "ghb" && args.includes("--dry-run"),
  );
  assert.strictEqual(preflights.length, 3);
  assert.include(preflights[0]?.args ?? [], "Tracker 📡");
  assert.include(preflights[1]?.args ?? [], "Task 🔨");
  assert.notInclude(NodeFS.readFileSync(NodePath.join(bundle, "parent.md"), "utf8"), "- [ ]");

  assert.throws(
    () => execute(parseArgs(["--create", "--bundle", bundle]), runner),
    /explicit approval of the exact publication bundle/,
  );
  execute(parseArgs(["--create", "--bundle", bundle, "--human-approved"]), runner);

  const filings = runner.calls.filter(
    ({ command, args }) => command === "ghb" && !args.includes("--dry-run"),
  );
  assert.strictEqual(filings.length, 3);
  assert.include(filings[0]?.args ?? [], "Tracker 📡");
  assert.include(filings[1]?.args ?? [], "--first");
  assert.include(filings[2]?.args ?? [], "--after");
  assert.include(filings[1]?.args ?? [], "--no-relationship");
  assert.include(filings[1]?.args ?? [], "RSI-Software/t3code-hyprws#900");
  const args = filings[0]?.args ?? [];
  assert.deepStrictEqual(args.slice(args.indexOf("--filed-by"), args.indexOf("--label")), [
    "--filed-by",
    "Human",
    "--human-approved",
    "--source",
    "fork-sync stable-prepare",
  ]);
});
