// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { CHECK_MIRROR, CHECK_ORIGIN_FETCH, type PreflightReport } from "./fork-preflight.ts";
import {
  type CheckoutBinding,
  inspectReport,
  parseArgs,
  run,
  UsageError,
} from "./fork-sync-gate.ts";
import type { SyncReport } from "./fork-sync-state.ts";

const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const REBASED_HEAD = "c".repeat(40);
const DEFAULT_BINDING: CheckoutBinding = {
  targetTag: "v1.2.3",
  targetSha: TARGET_SHA,
  expectedOld: SHA,
  rebasedHead: REBASED_HEAD,
  stackSize: "7",
};

/** The typed walk report the gate reads; the rendered record is never an input. */
const report = (options: Partial<CheckoutBinding> = {}): SyncReport => {
  const values = { ...DEFAULT_BINDING, ...options };
  return {
    schemaVersion: 2,
    stage: "checked",
    repositoryRoot: "/fixture",
    reportPath: "/fixture/report.json",
    recordPath: "/fixture/record.md",
    issue: { number: 1, blockingSha: SHA, title: "fixture" },
    candidates: [],
    conflicts: [],
    verification: [],
    source: { sha: SHA, sharedBase: SHA, expectedOld: values.expectedOld },
    target: { tag: values.targetTag, sha: values.targetSha },
    rebasedHead: values.rebasedHead,
    stackSize: Number(values.stackSize),
  } satisfies SyncReport;
};

const written = (path: string, value: SyncReport): void => {
  NodeFS.writeFileSync(path, `${JSON.stringify(value)}\n`);
};

const binding = (overrides: Partial<CheckoutBinding> = {}): CheckoutBinding => ({
  ...DEFAULT_BINDING,
  ...overrides,
});

it("keeps stable-only as the default and opts into nightly tags", () => {
  assert.deepStrictEqual(parseArgs(["--tag", "v1.2.3", "--report", "/tmp/report.json"]), {
    tag: "v1.2.3",
    reportPath: "/tmp/report.json",
    allowNightly: false,
  });
  assert.deepStrictEqual(
    parseArgs([
      "--allow-nightly",
      "--report",
      "/tmp/report.json",
      "--tag",
      "v1.2.3-nightly.20260828.4",
    ]),
    {
      tag: "v1.2.3-nightly.20260828.4",
      reportPath: "/tmp/report.json",
      allowNightly: true,
    },
  );
  assert.throws(
    () => parseArgs(["--tag", "v1.2.3-nightly.20260828.4", "--report", "/tmp/report.json"]),
    UsageError,
  );
  assert.throws(
    () => parseArgs(["--tag", "v1.2.3-nightly.4", "--report", "/tmp/report.json", "--allow-nightly"]),
    UsageError,
  );
  assert.throws(() => parseArgs(["--tag", "../../tmp", "--report", "/tmp/report.json"]), UsageError);
  assert.throws(() => parseArgs(["--tag", "v1.2.3"]), UsageError);
  assert.throws(() => parseArgs([]), UsageError);
});

it("compares the typed report's own bindings against the checkout", () => {
  assert.deepStrictEqual(inspectReport(report(), binding()), []);
  assert.deepStrictEqual(inspectReport(report({ expectedOld: "d".repeat(40) }), binding()), [
    `expected_old mismatch: report ${"d".repeat(40)}, origin/hyprws ${SHA}`,
  ]);
  assert.deepStrictEqual(inspectReport(report({ targetSha: "d".repeat(40) }), binding()), [
    `Target mismatch: report v1.2.3@${"d".repeat(40)}, checkout v1.2.3@${TARGET_SHA}`,
  ]);
  assert.deepStrictEqual(inspectReport(report({ rebasedHead: "d".repeat(40) }), binding()), [
    `Rebased head mismatch: report ${"d".repeat(40)}, checkout ${REBASED_HEAD}`,
  ]);
  assert.deepStrictEqual(inspectReport(report({ stackSize: "8" }), binding()), [
    "Stack size mismatch: report 8, checkout 7",
  ]);
});

it("names every binding a report never recorded", () => {
  const { source, target, rebasedHead, stackSize, ...partial } = report();
  void source;
  void target;
  void rebasedHead;
  void stackSize;
  assert.deepStrictEqual(inspectReport(partial satisfies SyncReport, binding()), [
    "report is missing expected_old",
    "report is missing Target",
    "report is missing Rebased head",
    "report is missing Stack size",
  ]);
});

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();

const gitDependency = (root: string, args: ReadonlyArray<string>): string => git(root, args);

const passingPreflight = (head: string | null): PreflightReport => ({
  checks: [{ name: "origin/hyprws fetched fresh", met: true, detail: "fetched", remedy: null }],
  originHyprwsSha: head,
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

const fixtureRepository = (): {
  root: string;
  recordRoot: string;
  targetSha: string;
  head: string;
  stackSize: string;
  reportPath: string;
} => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-gate-"));
  const recordRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-report-"));
  git(root, ["init", "-b", "fixture"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "target"]);
  const targetSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "v1.2.3", targetSha]);
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "fixture\nrebased\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "rebased"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const stackSize = git(root, ["rev-list", "--count", `${targetSha}..${head}`]);
  const reportPath = NodePath.join(recordRoot, "v1.2.3.json");
  written(reportPath, report({ targetSha, expectedOld: head, rebasedHead: head, stackSize }));
  return { root, recordRoot, targetSha, head, stackSize, reportPath };
};

it("runs against an external report and the preflight's freshly fetched head", () => {
  const { root, recordRoot, targetSha, head, stackSize, reportPath } = fixtureRepository();
  try {
    const { stdout, stderr, output } = collector();
    const dependencies = { preflight: () => passingPreflight(head), git: gitDependency };
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--report", reportPath], root, output, dependencies),
      0,
    );
    assert.match(stdout.join(""), /^ready: v1\.2\.3 apply gate passed/);

    written(reportPath, report({ targetSha, expectedOld: "d".repeat(40), rebasedHead: head, stackSize }));
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--report", reportPath], root, output, dependencies),
      1,
    );
    assert.include(stderr.join(""), "expected_old mismatch");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(recordRoot, { recursive: true, force: true });
  }
});

it("refuses a report inside the replayed repository", () => {
  const { root, recordRoot, targetSha, head, stackSize } = fixtureRepository();
  const reportPath = NodePath.join(root, "report.json");
  written(reportPath, report({ targetSha, expectedOld: head, rebasedHead: head, stackSize }));
  try {
    const { stderr, output } = collector();
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--report", reportPath], root, output, {
        preflight: () => passingPreflight(head),
        git: gitDependency,
      }),
      1,
    );
    assert.include(stderr.join(""), "walk report must be outside the repository");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(recordRoot, { recursive: true, force: true });
  }
});

it("refuses on an unmet precondition and names it before reading the report", () => {
  const { root, recordRoot, reportPath } = fixtureRepository();
  try {
    const { stderr, output } = collector();
    const preflight = {
      preflight: () => ({
        checks: [
          {
            name: "rerere.enabled",
            met: false,
            detail: "unset",
            remedy: "git config --global rerere.enabled true",
          },
          {
            name: "dependencies installed",
            met: true,
            detail: "node_modules is present",
            remedy: null,
          },
        ],
        originHyprwsSha: null,
      }),
      git: gitDependency,
    };
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--report", reportPath], root, output, preflight),
      1,
    );
    const written = stderr.join("");
    assert.include(written, "blocked: precondition unmet: rerere.enabled: unset");
    assert.include(written, "fix: git config --global rerere.enabled true");
    assert.notInclude(written, "dependencies installed");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(recordRoot, { recursive: true, force: true });
  }
});

it("passes a tag-pinned slice whose mirror fell behind mid-walk", () => {
  const { root, recordRoot, head, reportPath } = fixtureRepository();
  try {
    const { stdout, output } = collector();
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--report", reportPath], root, output, {
        preflight: () => ({
          checks: [
            { name: CHECK_ORIGIN_FETCH, met: true, detail: "fetched", remedy: null },
            {
              name: CHECK_MIRROR,
              met: false,
              detail: "origin/main 111111111111, upstream/main 222222222222",
              remedy: "dispatch hyprws-upstream-sync.yml",
            },
          ],
          originHyprwsSha: head,
        }),
        git: gitDependency,
      }),
      0,
    );
    assert.match(stdout.join(""), /^ready: v1\.2\.3 apply gate passed/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(recordRoot, { recursive: true, force: true });
  }
});

it("never falls back to resolving origin/hyprws itself", () => {
  const { root, recordRoot, reportPath } = fixtureRepository();
  try {
    const { stderr, output } = collector();
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--report", reportPath], root, output, {
        preflight: () => passingPreflight(null),
        git: gitDependency,
      }),
      1,
    );
    assert.include(stderr.join(""), "no freshly fetched origin/hyprws head");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(recordRoot, { recursive: true, force: true });
  }
});
