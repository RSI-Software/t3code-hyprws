// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  CHECK_DEPENDENCIES,
  CHECK_MIRROR,
  CHECK_RERERE,
  type PreflightReport,
} from "./fork-preflight.ts";
import {
  parseArgs,
  proveTarget,
  renderOrientation,
  run,
  UsageError,
  type Orientation,
} from "./fork-orient.ts";
import type { GitCommandResult } from "./lib/fork-rebase-feasibility.ts";

const TARGET_SHA = "f".repeat(40);
const SOURCE_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);

const ok = (stdout = ""): GitCommandResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr = "fatal"): GitCommandResult => ({ status: 1, stdout: "", stderr });

const gitReader = (table: Record<string, GitCommandResult>) => ({
  run: (args: ReadonlyArray<string>) => table[args.join(" ")]?.stdout ?? "",
  runResult: (args: ReadonlyArray<string>) => table[args.join(" ")] ?? failed(`unscripted`),
});

it("requires a target and rejects anything else", () => {
  assert.deepStrictEqual(parseArgs(["--target", "v0.0.35"]), {
    target: "v0.0.35",
    source: "origin/hyprws",
  });
  assert.deepStrictEqual(parseArgs(["--target", "v0.0.35", "--source", "HEAD"]), {
    target: "v0.0.35",
    source: "HEAD",
  });
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(["--target"]), UsageError);
  assert.throws(() => parseArgs(["--target", "v1", "--target", "v2"]), UsageError);
  assert.throws(() => parseArgs(["--json"]), UsageError);
});

it("refuses a version-shaped name that is not a tag", () => {
  const git = gitReader({ "rev-parse --verify refs/tags/v0.0.99^{commit}": failed() });
  assert.throws(() => proveTarget(git, "v0.0.99"), /is not a tag in this repository/);
});

it("refuses a tag that upstream/main does not contain", () => {
  const git = gitReader({
    "rev-parse --verify refs/tags/v0.0.34-hyprws.1^{commit}": ok(`${TARGET_SHA}\n`),
    [`merge-base --is-ancestor ${TARGET_SHA} upstream/main`]: failed(""),
  });
  assert.throws(() => proveTarget(git, "v0.0.34-hyprws.1"), /is not reachable from upstream\/main/);
});

it("proves a stable tag with merge-base --is-ancestor", () => {
  const git = gitReader({
    "rev-parse --verify refs/tags/v0.0.35^{commit}": ok(`${TARGET_SHA}\n`),
    [`merge-base --is-ancestor ${TARGET_SHA} upstream/main`]: ok(),
  });
  assert.deepStrictEqual(proveTarget(git, "v0.0.35"), {
    ref: "v0.0.35",
    sha: TARGET_SHA,
    stable: true,
    reachableFrom: "upstream/main",
  });
});

it("marks a nightly tag as not stable rather than refusing it", () => {
  const tag = "v0.0.35-nightly.20260828.1";
  const git = gitReader({
    [`rev-parse --verify refs/tags/${tag}^{commit}`]: ok(`${TARGET_SHA}\n`),
    [`merge-base --is-ancestor ${TARGET_SHA} upstream/main`]: ok(),
  });
  assert.strictEqual(proveTarget(git, tag).stable, false);
});

const orientation = (overrides: Partial<Orientation> = {}): Orientation => ({
  target: {
    ref: "v0.0.36",
    sha: TARGET_SHA,
    stable: true,
    reachableFrom: "upstream/main",
  },
  source: { ref: "origin/hyprws", sha: SOURCE_SHA },
  sharedBase: BASE_SHA,
  mirror: "origin/main matches upstream/main at c8aba2587d56",
  dependencies: "node_modules is absent",
  feasibility: {
    upstreamCommitCount: 43,
    cleanCommitCount: 41,
    firstConflict: "abc1234 feat(web): move the sidebar",
    conflictFiles: ["apps/web/src/Sidebar.tsx (3 hunks)"],
  },
  overlap: {
    upstreamChanged: 120,
    forkChanged: 30,
    overlap: 4,
    hardConflict: 1,
    automerged: ["package.json"],
  },
  retireCandidates: [
    {
      subject: "feat(web): themed menus",
      domain: "workspace-files",
      decision: "candidate",
      signals: ["already-upstream: same file"],
    },
  ],
  watch: {
    target: "v0.0.36",
    issues: [
      { number: 150, status: "ready", title: "zoom flash" },
      { number: 151, status: "waiting", title: "context menu" },
    ],
    error: null,
  },
  ...overrides,
});

it("prints every Gate 1 field and the Stop block", () => {
  const rendered = renderOrientation(orientation());
  for (const expected of [
    `target:       v0.0.36@${TARGET_SHA}`,
    `source:       origin/hyprws@${SOURCE_SHA}`,
    `shared base:  ${BASE_SHA}`,
    "mirror:       origin/main matches upstream/main at c8aba2587d56",
    "41 of 43 upstream commits clean; first conflict abc1234 feat(web): move the sidebar",
    "apps/web/src/Sidebar.tsx (3 hunks)",
    "  - package.json",
    "[candidate] feat(web): themed menus (workspace-files)",
    "#150 [ready] zoom flash",
    "Stop. This report is orientation, not permission to modify a ref.",
    "  automerged overlap: 1 files",
    "  retire candidates:  1",
    "  upstream-watch:     2 open: 1 ready, 1 waiting",
    "Continue only after the human confirms the target.",
  ]) {
    assert.include(rendered, expected);
  }
});

it("names a nightly target as outside what the apply gate accepts", () => {
  const rendered = renderOrientation(
    orientation({
      target: {
        ref: "v0.0.36-nightly.1",
        sha: TARGET_SHA,
        stable: false,
        reachableFrom: "upstream/main",
      },
    }),
  );
  assert.include(rendered, "nightly tag; the apply gate needs --allow-nightly");
});

const preflight = (
  overrides: ReadonlyArray<{
    name: string;
    met: boolean;
    detail: string;
    remedy: string | null;
  }> = [],
): PreflightReport => ({
  checks: [
    { name: CHECK_RERERE, met: true, detail: "true", remedy: null },
    { name: CHECK_MIRROR, met: true, detail: "origin/main matches upstream/main", remedy: null },
    { name: CHECK_DEPENDENCIES, met: true, detail: "node_modules is present", remedy: null },
    ...overrides,
  ],
  originHyprwsSha: SOURCE_SHA,
});

const collector = () => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
};

const fixtureRoot = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-orient-"));
  NodeChildProcess.execFileSync("git", ["init", "-b", "fixture"], { cwd: root });
  return root;
};

it("refuses a Gate 1 precondition and never orients", () => {
  const root = fixtureRoot();
  try {
    const { stderr, output } = collector();
    let oriented = false;
    const code = run(["--target", "v0.0.36"], root, output, {
      preflight: () => ({
        checks: [
          {
            name: CHECK_RERERE,
            met: false,
            detail: "unset",
            remedy: "git config --global rerere.enabled true",
          },
        ],
        originHyprwsSha: null,
      }),
      orient: () => {
        oriented = true;
        return orientation();
      },
    });
    assert.strictEqual(code, 1);
    assert.isFalse(oriented);
    assert.include(stderr.join(""), "blocked: precondition unmet: rerere.enabled: unset");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("orients in a worktree with no dependencies installed", () => {
  const root = fixtureRoot();
  try {
    const { stdout, output } = collector();
    const code = run(["--target", "v0.0.36"], root, output, {
      preflight: () =>
        preflight([
          {
            name: CHECK_DEPENDENCIES,
            met: false,
            detail: "node_modules is absent",
            remedy: "vp i",
          },
        ]),
      orient: () => orientation(),
    });
    assert.strictEqual(code, 0);
    assert.include(stdout.join(""), "dependencies: node_modules is absent");
    assert.include(stdout.join(""), "Stop. This report is orientation");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("prints the orientation and exits 1 when the watch sweep fails", () => {
  const root = fixtureRoot();
  try {
    const { stdout, output } = collector();
    const code = run(["--target", "v0.0.36"], root, output, {
      preflight: () => preflight(),
      orient: () =>
        orientation({
          watch: { target: "v0.0.36", issues: [], error: "gh: Not Found (HTTP 404)" },
        }),
    });
    assert.strictEqual(code, 1);
    const written = stdout.join("");
    assert.include(written, "sweep failed: gh: Not Found (HTTP 404)");
    assert.include(written, "upstream-watch:     sweep failed: gh: Not Found (HTTP 404)");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("prints help without touching a repository", () => {
  const { stdout, output } = collector();
  assert.strictEqual(run(["--help"], process.cwd(), output), 0);
  assert.include(stdout.join(""), "Usage: vp run fork:orient --target vX.Y.Z");
});
