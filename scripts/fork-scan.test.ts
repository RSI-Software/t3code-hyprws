import { assert, it } from "@effect/vitest";

import {
  buildScanResult,
  commitFilesArguments,
  findForkOwnedTypecheckGaps,
  matchesScanPattern,
  parseArgs,
  parseCommitFiles,
  parseRebaseScans,
  renderScanReport,
  scanFailures,
  scanFailureSummary,
  UsageError,
  type ScanInput,
} from "./fork-scan.ts";

const RS = "";

// Shaped like docs/internals/fork-delta.md: domain sections with a rebase scan,
// plus the prose sections that must not be read as domains.
const ledger = `# Fork delta

\`\`\`bash
vp run fork:scan
\`\`\`

## Retired

| Fork commit | Domain | Upstream replacement |
| --- | --- | --- |
| \`apps/web/src/retired.ts\` | project-windows | gone |

## project-windows

### Shape

The core is \`apps/web/src/notScanned.ts\`.

### Rebase scan

| Path | Why it matters |
| --- | --- |
| \`apps/desktop/src/window/DesktopWindow.ts\` | The window service the fork makes plural. |
| \`apps/desktop/src/ipc/**\` | The bridge surface. |
| \`apps/web/src/routes/project.*\` | Fork-only route subtree. |
| \`package.json\` scripts block | The aliases sit between upstream ones. |

## upstream-fixes

### Rebase scan

| Path | Why it matters |
| --- | --- |
| \`**\` (each commit's own diff) | Upstream probably fixed it differently. |

## Adding a domain

Answer three questions.
`;

const commit = (short: string, domain: string | undefined) => ({
  sha: short.padEnd(40, "0"),
  short,
  subject: `feat: ${short}`,
  ...(domain === undefined ? {} : { domain, tier: "core" }),
});

const scanInput = (overrides: Partial<ScanInput> = {}): ScanInput => ({
  base: "base",
  head: "HEAD",
  target: "upstream/main",
  commits: [commit("aaaaaaa", "project-windows")],
  filesBySha: new Map([["aaaaaaa".padEnd(40, "0"), ["apps/web/src/components/Sidebar.logic.ts"]]]),
  scans: parseRebaseScans(ledger),
  forkChanged: new Set(["apps/web/src/components/Sidebar.logic.ts"]),
  upstreamChanged: new Set(["apps/web/src/components/Sidebar.logic.ts"]),
  ...overrides,
});

it("reads one pattern per code span from every domain's rebase scan", () => {
  const scans = parseRebaseScans(ledger);
  assert.deepStrictEqual([...scans.keys()], ["project-windows", "upstream-fixes"]);
  assert.deepStrictEqual(scans.get("project-windows"), [
    "apps/desktop/src/window/DesktopWindow.ts",
    "apps/desktop/src/ipc/**",
    "apps/web/src/routes/project.*",
    "package.json",
  ]);
  assert.deepStrictEqual(scans.get("upstream-fixes"), ["**"]);
});

it("matches a segment with * and a subtree with **", () => {
  assert.isTrue(
    matchesScanPattern("apps/web/src/routes/project.*", "apps/web/src/routes/project.tsx"),
  );
  assert.isFalse(
    matchesScanPattern("apps/web/src/routes/project.*", "apps/web/src/routes/project/index.tsx"),
  );
  assert.isTrue(matchesScanPattern("apps/desktop/src/ipc/**", "apps/desktop/src/ipc/methods/a.ts"));
  assert.isFalse(matchesScanPattern("apps/desktop/src/ipc/**", "apps/desktop/src/preview/a.ts"));
  assert.isTrue(matchesScanPattern("**", "anything/at/all.ts"));
  assert.isFalse(matchesScanPattern("package.json", "apps/web/package.json"));
});

it("pairs each commit with the files it touches", () => {
  const raw = `${RS}aaa\n\nfirst.ts\nsecond.ts\n${RS}bbb\n\nthird.ts\n`;
  assert.deepStrictEqual(
    [...parseCommitFiles(raw)],
    [
      ["aaa", ["first.ts", "second.ts"]],
      ["bbb", ["third.ts"]],
    ],
  );
  assert.deepStrictEqual(commitFilesArguments(["aaa"]).slice(2, 4), ["show", "--name-only"]);
});

it("fails a file both the fork and upstream changed that the scan omits", () => {
  const result = buildScanResult(scanInput());
  assert.deepStrictEqual(result.domains, [
    {
      domain: "project-windows",
      commitCount: 1,
      sharedCount: 1,
      gaps: ["apps/web/src/components/Sidebar.logic.ts"],
    },
  ]);
  assert.deepStrictEqual(scanFailures(result), [
    "project-windows: rebase scan omits apps/web/src/components/Sidebar.logic.ts",
  ]);
  assert.include(renderScanReport(result), "MISSING  project-windows");
});

it("ignores a file only the fork changed and a file only upstream changed", () => {
  const forkOnly = buildScanResult(scanInput({ upstreamChanged: new Set() }));
  assert.deepStrictEqual(scanFailures(forkOnly), []);
  assert.strictEqual(forkOnly.overlaps.length, 0);

  // Reverted mid-stack: a commit touched it, the net fork diff does not carry it.
  const reverted = buildScanResult(scanInput({ forkChanged: new Set() }));
  assert.deepStrictEqual(scanFailures(reverted), []);
});

it("accepts a file a scan pattern covers", () => {
  const covered = buildScanResult(
    scanInput({
      filesBySha: new Map([
        ["aaaaaaa".padEnd(40, "0"), ["apps/desktop/src/ipc/methods/preview.ts"]],
      ]),
      forkChanged: new Set(["apps/desktop/src/ipc/methods/preview.ts"]),
      upstreamChanged: new Set(["apps/desktop/src/ipc/methods/preview.ts"]),
    }),
  );
  assert.deepStrictEqual(scanFailures(covered), []);
  assert.deepStrictEqual(covered.overlaps, [
    { path: "apps/desktop/src/ipc/methods/preview.ts", domain: "project-windows", covered: true },
  ]);
});

it("fails a domain that has commits but no rebase scan, and skips untagged commits", () => {
  const result = buildScanResult(
    scanInput({
      commits: [commit("aaaaaaa", "zmux-estate"), commit("bbbbbbb", undefined)],
      filesBySha: new Map([["aaaaaaa".padEnd(40, "0"), ["apps/server/src/terminal/Manager.ts"]]]),
      forkChanged: new Set(["apps/server/src/terminal/Manager.ts"]),
      upstreamChanged: new Set(["apps/server/src/terminal/Manager.ts"]),
    }),
  );
  assert.deepStrictEqual(scanFailures(result), [
    "zmux-estate: no domain section with a rebase scan in docs/internals/fork-delta.md",
  ]);
  assert.deepStrictEqual(result.untaggedCommits, ["bbbbbbb"]);
});

it("attributes one shared file to every domain whose commits touch it", () => {
  const result = buildScanResult(
    scanInput({
      commits: [commit("aaaaaaa", "project-windows"), commit("bbbbbbb", "upstream-fixes")],
      filesBySha: new Map([
        ["aaaaaaa".padEnd(40, "0"), ["apps/server/src/provider/Layers/GrokAdapter.ts"]],
        ["bbbbbbb".padEnd(40, "0"), ["apps/server/src/provider/Layers/GrokAdapter.ts"]],
      ]),
      forkChanged: new Set(["apps/server/src/provider/Layers/GrokAdapter.ts"]),
      upstreamChanged: new Set(["apps/server/src/provider/Layers/GrokAdapter.ts"]),
    }),
  );
  assert.deepStrictEqual(
    result.overlaps.map((overlap) => `${overlap.domain}:${overlap.covered}`),
    ["project-windows:false", "upstream-fixes:true"],
  );
});

it("surfaces a rehearsed-head typecheck failure in a fork-owned file as a gap", () => {
  const calls: Array<string> = [];
  const gaps = findForkOwnedTypecheckGaps(
    "/repo",
    new Set([
      "apps/web/src/components/githubIssue/GitHubIssueDetailPanel.test.tsx",
      "apps/server/src/fork-only.ts",
      "packages/contracts/src/fork-only.ts",
    ]),
    (_root, command) => {
      calls.push(command.packageName);
      if (command.workspace === "apps/web") {
        return {
          status: 2,
          stdout:
            "src/components/githubIssue/GitHubIssueDetailPanel.test.tsx(20,7): error TS2741: Property 'files' is missing.\n" +
            "src/upstream-owned.ts(1,1): error TS2322: Type mismatch.\n",
          stderr: "",
        };
      }
      if (command.workspace === "packages/contracts") {
        return {
          status: 2,
          stdout: "src/fork-only.ts(3,9): error TS2551: Property does not exist.\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  );

  assert.deepStrictEqual(calls, [
    "@t3tools/web",
    "t3",
    "@t3tools/desktop",
    "@t3tools/mobile",
    "@t3tools/contracts",
    "@t3tools/client-runtime",
    "@t3tools/shared",
  ]);
  assert.deepStrictEqual(gaps, [
    {
      workspace: "apps/web",
      path: "apps/web/src/components/githubIssue/GitHubIssueDetailPanel.test.tsx",
    },
    { workspace: "packages/contracts", path: "packages/contracts/src/fork-only.ts" },
  ]);
  const result = { ...buildScanResult(scanInput()), typecheckGaps: gaps };
  assert.include(
    scanFailures(result),
    "typecheck: fork-owned file fails on rehearsed head: apps/web/src/components/githubIssue/GitHubIssueDetailPanel.test.tsx",
  );
  assert.include(renderScanReport(result), "Fork-owned typecheck gaps:");
});

it("summarises each gap class with its own repair", () => {
  const clean = buildScanResult(scanInput({ upstreamChanged: new Set() }));
  assert.deepStrictEqual(scanFailureSummary(clean), []);

  const ledgerOnly = buildScanResult(scanInput());
  assert.deepStrictEqual(scanFailureSummary(ledgerOnly), [
    "failed: 1 rebase-scan gap(s); add each path to its domain's Rebase scan table in docs/internals/fork-delta.md",
  ]);

  const seam = [{ workspace: "apps/web", path: "apps/web/src/fork-only.ts" }];
  assert.deepStrictEqual(scanFailureSummary({ ...clean, typecheckGaps: seam }), [
    "failed: 1 typecheck gap(s); fix each as a silent seam in the fork commit that owns the file, then rerun",
  ]);

  assert.lengthOf(scanFailureSummary({ ...ledgerOnly, typecheckGaps: seam }), 2);
});

it("defaults the target to upstream/main and the base to the merge base", () => {
  assert.deepStrictEqual(parseArgs([]), {
    base: null,
    head: "HEAD",
    target: "upstream/main",
    typecheck: true,
  });
  assert.deepStrictEqual(
    parseArgs(["--head", "origin/hyprws", "--target", "v0.0.35", "--no-typecheck"]),
    {
      base: null,
      head: "origin/hyprws",
      target: "v0.0.35",
      typecheck: false,
    },
  );
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  assert.throws(() => parseArgs(["--target", "a", "--target", "b"]), UsageError);
  assert.throws(() => parseArgs(["--target"]), UsageError);
  assert.throws(() => parseArgs(["--no-typecheck", "--no-typecheck"]), UsageError);
});
