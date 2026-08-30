import { assert, it } from "@effect/vitest";

import {
  differenceRows,
  firstParagraph,
  parseArgs,
  partitionUatRows,
  relationshipArguments,
  renderUatBody,
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

it("renders collapsed sources, empty UAT, exclusions, and the close condition", () => {
  const body = renderUatBody({
    ref: "origin/release/v1.4.0-hyprws",
    sha: "a".repeat(40),
    targetVersion: "v1.4.0-hyprws",
    upstreamBaseTag: "v1.4.0",
    upstreamBaseSha: "b".repeat(40),
    previousStable: "v1.3.0-hyprws.12",
    previousStableOverridden: true,
    relatesTo: 321,
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
  assert.include(body, "## UAT\n\n<!-- agent: write rows here, see SKILL.md -->");
  assert.notInclude(body, "- [ ]");
  assert.include(body, "## Excluded");
  assert.include(body, "<details>");
  assert.include(body, "`1234567` ci(fork): publish support — Fork-Domain fork-meta");
  assert.include(body, "## Close condition");
  assert.include(body, "Comment `Signed off`");
});

it("requires creation from a reviewed body and refuses the reviewer-only section", () => {
  assert.throws(() => parseArgs(["--create"]), /--create requires --body/);
  assert.deepStrictEqual(parseArgs(["--create", "--body", "draft.md"]), {
    ref: "hyprws",
    version: null,
    since: null,
    relatesTo: null,
    output: null,
    body: "draft.md",
    create: true,
  });
  const metadata = `## Snapshot\n\n- Target: \`v1.4.0-hyprws\`\n- Ref: \`hyprws\`\n- Commit: \`${"a".repeat(40)}\``;
  assert.throws(
    () =>
      reviewedDraft(`${metadata}\n\n## Sources\n\nRaw material\n\n## UAT\n\n- [ ] Test behavior\n`),
    /still contains ## Sources/,
  );
  assert.throws(
    () => reviewedDraft(`${metadata}\n\n## UAT\n\n- [ ] Test behavior\n\n## Excluded\n`),
    /still contains ## Excluded/,
  );
  assert.throws(
    () => reviewedDraft(`${metadata}\n\n- [ ] Checkbox outside UAT\n\n## UAT\n\nNo rows\n`),
    /no unchecked UAT rows/,
  );
  assert.throws(
    () => reviewedDraft(`${metadata}\n\n## UAT\n\n- [ ] Test behavior\n`),
    /no feature heading/,
  );
  assert.deepStrictEqual(
    reviewedDraft(
      `Related issue: \`RSI-Software/t3code-hyprws#321\`.\n\n## Snapshot\n\n- Target: \`v1.4.0-hyprws\`\n- Ref: \`hyprws\`\n- Commit: \`${"a".repeat(40)}\`\n\n## UAT\n\n### Project windows\n\n- [ ] Projects open in separate windows\n`,
    ),
    {
      ref: "hyprws",
      sha: "a".repeat(40),
      targetVersion: "v1.4.0-hyprws",
      relatesTo: 321,
    },
  );
});
