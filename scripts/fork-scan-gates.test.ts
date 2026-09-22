// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import { assert, it } from "@effect/vitest";

import {
  buildScanResult,
  renderScanReport,
  resolveGuardedCommits,
  scanFailures,
  type ScanInput,
} from "./fork-scan.ts";
import {
  forkTestSibling,
  parseCommitPatches,
  significantTestLines,
  type AuthoringGuardInput,
} from "./fork-scan-authoring.ts";

const ledger = `# Fork delta

## example

### Rebase scan

| Path | Why |
| --- | --- |
| \`apps/web/src/thing.ts\` | The seam. |
`;

const baseInput = (guard?: AuthoringGuardInput): ScanInput => ({
  base: "base",
  head: "head",
  target: "target",
  commits: [
    {
      sha: "abc1234",
      short: "abc1234",
      subject: "feat: thing",
      domain: "example",
      tier: "core",
    },
  ],
  filesBySha: new Map([["abc1234", ["apps/web/src/thing.ts"]]]),
  scans: new Map([["example", ["apps/web/src/thing.ts"]]]),
  forkChanged: new Set(["apps/web/src/thing.ts"]),
  upstreamChanged: new Set(),
  ...(guard === undefined ? {} : { guard }),
});

it("stays green with no guard input", () => {
  const result = buildScanResult(baseInput());
  assert.deepStrictEqual(scanFailures(result), []);
  assert.match(renderScanReport(result), /1 commit\(s\), 0 shared file\(s\)/);
});

it("fails an additive files finding carried on the scan result", () => {
  // The CI `Fork rebase scan` step invokes `fork:scan` directly, never
  // `fork:ci`: the additive gate only gates a pull request if a finding
  // computed from the scan's own range fails the scan.
  const result = buildScanResult({
    ...baseInput(),
    additive: [
      {
        check: "files",
        path: "apps/web/src/gone.ts",
        detail: "upstream file is missing from the head tree",
      },
    ],
  });
  const failures = scanFailures(result);
  assert.isTrue(
    failures.some((failure) => failure.startsWith("additive:files: apps/web/src/gone.ts")),
  );
});

it("--replay-of is not a replay signal; --since scopes the guards", () => {
  // `--replay-of` is emitted whenever origin/hyprws resolves — every
  // ordinary pull request — so it must never suppress guard selection.
  // Commit recency via the `--since` range is what limits enforcement to
  // new work.
  const throwingGit = {
    run: () => {
      throw new Error("must not read git when since is null");
    },
  };
  const commits = [
    {
      sha: "abc1234",
      short: "abc1234",
      subject: "feat: thing",
      domain: "example",
      tier: "core",
    },
  ];
  const opts = {
    base: null,
    head: "head",
    target: "target",
    typecheck: false,
  } as const;
  const range = { base: "base", head: "head", target: "target" };
  // A null since selects the commit even with --replay-of present.
  assert.deepStrictEqual(
    resolveGuardedCommits(
      throwingGit,
      { ...opts, since: null, replayOf: "origin/hyprws" },
      range,
      commits,
    ),
    commits,
  );
  // A since range that excludes the commit excludes it, replay flag or not.
  const excludingGit = { run: () => "" };
  assert.deepStrictEqual(
    resolveGuardedCommits(
      excludingGit,
      { ...opts, since: "since", replayOf: "origin/hyprws" },
      range,
      commits,
    ),
    [],
  );
});

it("fails an upstream-test addition in the since range", () => {
  const raw = [
    "abc1234",
    "--- a/apps/web/src/other.test.ts",
    "+++ b/apps/web/src/other.test.ts",
    "@@ -0,0 +1 @@",
    '+it("fork case", () => {});',
    "",
  ].join("\n");
  const result = buildScanResult(
    baseInput({
      commits: [{ sha: "abc1234", short: "abc1234", domain: "example" }],
      filesBySha: new Map([["abc1234", ["apps/web/src/other.test.ts"]]]),
      patchesBySha: parseCommitPatches(raw),
      upstreamFiles: new Set(["apps/web/src/other.test.ts"]),
      upstreamTestFiles: new Set(["apps/web/src/other.test.ts"]),
      upstreamTestLines: new Map([["apps/web/src/other.test.ts", new Set()]]),
    }),
  );
  const failures = scanFailures(result);
  assert.isTrue(failures.some((failure) => failure.startsWith("upstream-test:")));
});

it("passes a declared-superseded deletion and still fails an undeclared one", () => {
  // RSI-Software/t3code-hyprws#1208: the sibling declares the upstream case the fork
  // contradicts, so deleting the fork's in-place rewrite from the upstream copy is
  // the documented move, not an upstream rewrite. The declaration text rides on the
  // guard input the same way the target-tree line sets do.
  const removedCase = [
    "abc1234",
    "--- a/apps/web/src/thing.test.ts",
    "+++ b/apps/web/src/thing.test.ts",
    "@@ -1,3 +1,0 @@",
    '-it("upstream", () => {',
    "-  expect(keep).toBe(2);",
    "-});",
    "",
  ].join("\n");
  const guardInput = ({
    upstreamTestTexts,
    siblingTexts,
  }: {
    upstreamTestTexts: ReadonlyMap<string, string>;
    siblingTexts: ReadonlyMap<string, string>;
  }): AuthoringGuardInput => ({
    commits: [{ sha: "abc1234", short: "abc1234", domain: "example" }],
    filesBySha: new Map([["abc1234", ["apps/web/src/thing.test.ts"]]]),
    patchesBySha: parseCommitPatches(removedCase),
    upstreamFiles: new Set(["apps/web/src/thing.test.ts"]),
    upstreamTestFiles: new Set(["apps/web/src/thing.test.ts"]),
    upstreamTestLines: new Map([
      ["apps/web/src/thing.test.ts", new Set(["expect(keep).toBe(2);"])],
    ]),
    upstreamTestTexts,
    siblingTexts,
  });
  const upstreamText = 'it("upstream", () => {\n  expect(keep).toBe(1);\n});\n';
  const declaredSibling =
    'forkSupersedes({ upstream: "apps/web/src/thing.test.ts > upstream", reason: "the fork inverts it", commit: "abc1234" });\n' +
    'it("replacement", () => {\n  expect(keep).toBe(2);\n});\n';
  const declared = buildScanResult(
    baseInput(
      guardInput({
        upstreamTestTexts: new Map([["apps/web/src/thing.test.ts", upstreamText]]),
        siblingTexts: new Map([["apps/web/src/thing.fork.test.ts", declaredSibling]]),
      }),
    ),
  );
  assert.isFalse(
    scanFailures(declared).some((failure) => failure.startsWith("upstream-test:")),
    "a declared-superseded deletion must not warn",
  );
  const undeclared = buildScanResult(
    baseInput(
      guardInput({
        upstreamTestTexts: new Map([["apps/web/src/thing.test.ts", upstreamText]]),
        siblingTexts: new Map([
          ["apps/web/src/thing.fork.test.ts", 'it("replacement", () => {});\n'],
        ]),
      }),
    ),
  );
  assert.isTrue(
    scanFailures(undeclared).some((failure) => failure.startsWith("upstream-test:")),
    "an undeclared deletion must still warn",
  );
  const bareDeclaration = buildScanResult(
    baseInput(
      guardInput({
        upstreamTestTexts: new Map([["apps/web/src/thing.test.ts", upstreamText]]),
        siblingTexts: new Map([
          [
            "apps/web/src/thing.fork.test.ts",
            'forkSupersedes({ upstream: "apps/web/src/thing.test.ts > upstream", reason: "the fork inverts it", commit: "abc1234" });\n',
          ],
        ]),
      }),
    ),
  );
  assert.isTrue(
    scanFailures(bareDeclaration).some((failure) => failure.startsWith("upstream-test:")),
    "a declaration with no replacement case in the sibling must not exempt",
  );
});

it("fails a replaced export matched by name across files", () => {
  const raw = [
    "abc1234",
    "--- a/apps/web/src/upstream.ts",
    "+++ b/apps/web/src/upstream.ts",
    "@@ -1 +0,0 @@",
    "-export const shared = 1;",
    "--- /dev/null",
    "+++ b/apps/web/src/upstream.fork.ts",
    "@@ -0,0 +1 @@",
    "+export const shared = 2;",
    "",
  ].join("\n");
  const result = buildScanResult(
    baseInput({
      commits: [{ sha: "abc1234", short: "abc1234", domain: "example" }],
      filesBySha: new Map([
        ["abc1234", ["apps/web/src/upstream.ts", "apps/web/src/upstream.fork.ts"]],
      ]),
      patchesBySha: parseCommitPatches(raw),
      upstreamFiles: new Set(["apps/web/src/upstream.ts"]),
      upstreamTestFiles: new Set(),
      upstreamTestLines: new Map(),
    }),
  );
  const failures = scanFailures(result);
  assert.isTrue(failures.some((failure) => failure.startsWith("replaced-export:")));
});

it("flags an unmarked insertion through the hook guard", () => {
  const raw = [
    "abc1234",
    "--- a/apps/web/src/thing.ts",
    "+++ b/apps/web/src/thing.ts",
    "@@ -1 +1,2 @@",
    "+export const forkThing = 1;",
    "",
  ].join("\n");
  const result = buildScanResult(
    baseInput({
      commits: [{ sha: "abc1234", short: "abc1234", domain: "example" }],
      filesBySha: new Map([["abc1234", ["apps/web/src/thing.ts"]]]),
      patchesBySha: parseCommitPatches(raw),
      upstreamFiles: new Set(["apps/web/src/thing.ts"]),
      upstreamTestFiles: new Set(),
      upstreamTestLines: new Map(),
    }),
  );
  assert.isTrue(result.hookDetails.some((detail) => detail.includes("outside a marked hook")));
  assert.isTrue(scanFailures(result).some((failure) => failure.startsWith("hook-guard:")));
});

it("passes a hook-guard restore the target tree already has", () => {
  // RSI-Software/t3code-hyprws#1207 end to end: the guard input carries the
  // target-tree lines, so a byte-identical restore stays silent while a
  // genuine insertion still fails.
  const raw = [
    "abc1234",
    "--- a/apps/web/src/thing.ts",
    "+++ b/apps/web/src/thing.ts",
    "@@ -1 +1,2 @@",
    '+it("replaces the standalone explorer", () => {});',
    "+export const forkThing = 1;",
    "",
  ].join("\n");
  const restored = 'it("replaces the standalone explorer", () => {});';
  const guard = {
    commits: [{ sha: "abc1234", short: "abc1234", domain: "example" }],
    filesBySha: new Map([["abc1234", ["apps/web/src/thing.ts"]]]),
    patchesBySha: parseCommitPatches(raw),
    upstreamFiles: new Set(["apps/web/src/thing.ts"]),
    upstreamTestFiles: new Set<string>(),
    upstreamTestLines: new Map(),
    upstreamLines: new Map([["apps/web/src/thing.ts", new Set([restored])]]),
  };
  const mixed = buildScanResult(baseInput(guard));
  assert.isTrue(
    mixed.hookDetails.some((detail) => detail.includes("export const forkThing = 1;")) &&
      !mixed.hookDetails.some((detail) => detail.includes("replaces the standalone")),
  );
  const clean = buildScanResult(
    baseInput({
      ...guard,
      patchesBySha: parseCommitPatches(
        [
          "abc1234",
          "--- a/apps/web/src/thing.ts",
          "+++ b/apps/web/src/thing.ts",
          "@@ -1 +1 @@",
          `+${restored}`,
          "",
        ].join("\n"),
      ),
    }),
  );
  assert.deepStrictEqual(clean.hookDetails, []);
  assert.isFalse(scanFailures(clean).some((failure) => failure.startsWith("hook-guard:")));
});

it("reads the sibling name and significant lines", () => {
  assert.equal(forkTestSibling("apps/web/src/thing.test.tsx"), "apps/web/src/thing.fork.test.tsx");
  assert.deepStrictEqual(
    [...significantTestLines("// comment\n\nexpect(1).toBe(1);\n")],
    ["expect(1).toBe(1);"],
  );
  void ledger;
});

it("fails supersedes refusals and reports undeclared contradictions", () => {
  const declared = buildScanResult({
    ...baseInput(),
    supersedes: [
      "thing.fork.test.ts:3: forkSupersedes is missing commit; a declaration names the upstream case, why the fork differs, and the fork commit",
    ],
  });
  assert.isTrue(scanFailures(declared).some((failure) => failure.startsWith("supersedes:")));
  assert.match(renderScanReport(declared), /Supersedes, 1 finding/);

  const clean = buildScanResult(baseInput());
  assert.isFalse(scanFailures(clean).some((failure) => failure.startsWith("supersedes:")));
});

it("surfaces a retire candidate without failing the scan", () => {
  // AGENTS.md: the rebase feasibility walk flags a retire candidate. The
  // pinned-target walk (`fork:scan --target vX.Y.Z`) is that walk's home:
  // the candidate is reported, never a failure, so the declaration and its
  // sibling case are deleted in the same change by a human.
  const result = buildScanResult({
    ...baseInput(),
    retireCandidates: [
      {
        sibling: "apps/web/src/thing.fork.test.ts",
        upstreamPath: "apps/web/src/thing.test.ts",
        upstreamTitle: "keeps the case",
        reason: "the fork inverts it",
        commit: "abc1234",
        line: 3,
      },
    ],
  });
  assert.deepStrictEqual(scanFailures(result), []);
  assert.match(renderScanReport(result), /Retire candidates, 1/);
  assert.match(renderScanReport(result), /delete the declaration and its sibling case/);
});
