// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import type { PreflightReport } from "./fork-preflight.ts";
import { inspectRecord, parseArgs, run, UsageError } from "./fork-sync-gate.ts";

const SHA = "a".repeat(40);
const record = (expectedOld = SHA, sanity = "donjor 2026-08-27") => `# Rehearsal\n
## Header\n
- \`expected_old\`: \`${expectedOld}\`\n
- Human sanity: ${sanity}\n`;

it("keeps stable-only as the default and opts into nightly tags", () => {
  assert.deepStrictEqual(parseArgs(["--tag", "v1.2.3"]), {
    tag: "v1.2.3",
    allowNightly: false,
  });
  assert.deepStrictEqual(parseArgs(["--allow-nightly", "--tag", "v1.2.3-nightly.20260828.4"]), {
    tag: "v1.2.3-nightly.20260828.4",
    allowNightly: true,
  });
  assert.throws(() => parseArgs(["--tag", "v1.2.3-nightly.20260828.4"]), UsageError);
  assert.throws(() => parseArgs(["--tag", "v1.2.3-nightly.4", "--allow-nightly"]), UsageError);
  assert.throws(() => parseArgs(["--tag", "../../tmp"]), UsageError);
  assert.throws(() => parseArgs([]), UsageError);
});

it("requires a matching expected_old and a login plus calendar date", () => {
  assert.deepStrictEqual(inspectRecord(record(), SHA), []);
  assert.deepStrictEqual(inspectRecord(record("b".repeat(40)), SHA), [
    `expected_old mismatch: record ${"b".repeat(40)}, origin/hyprws ${SHA}`,
  ]);
  assert.deepStrictEqual(inspectRecord(record(SHA, "absent"), SHA), [
    'missing Human sanity mark: expected "Human sanity: <login> YYYY-MM-DD"',
  ]);
  assert.deepStrictEqual(inspectRecord(record(SHA, "donjor 2026-02-30"), SHA), [
    'missing Human sanity mark: expected "Human sanity: <login> YYYY-MM-DD"',
  ]);
  assert.deepStrictEqual(
    inspectRecord(
      `# Rehearsal\n\n## Notes\n\n- \`expected_old\`: \`${SHA}\`\n- Human sanity: donjor 2026-08-27\n`,
      SHA,
    ),
    [
      "record header missing `expected_old` full SHA",
      'missing Human sanity mark: expected "Human sanity: <login> YYYY-MM-DD"',
    ],
  );
});

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();

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

const fixtureRepository = (): { root: string; head: string; recordPath: string } => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-gate-"));
  git(root, ["init", "-b", "fixture"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "fixture"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const directory = NodePath.join(root, "docs/operations/fork-sync-records");
  NodeFS.mkdirSync(directory, { recursive: true });
  const recordPath = NodePath.join(directory, "v1.2.3.md");
  NodeFS.writeFileSync(recordPath, record(head));
  return { root, head, recordPath };
};

it("runs against the repository record and the preflight's freshly fetched head", () => {
  const { root, head, recordPath } = fixtureRepository();
  try {
    const { stdout, stderr, output } = collector();
    const preflight = { preflight: () => passingPreflight(head) };
    assert.strictEqual(run(["--tag", "v1.2.3"], root, output, preflight), 0);
    assert.match(stdout.join(""), /^ready: v1\.2\.3 apply gate passed/);

    NodeFS.writeFileSync(recordPath, record(head, "absent"));
    assert.strictEqual(run(["--tag", "v1.2.3"], root, output, preflight), 1);
    assert.include(stderr.join(""), "missing Human sanity mark");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses on an unmet precondition and names it before reading the record", () => {
  const { root } = fixtureRepository();
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
    };
    assert.strictEqual(run(["--tag", "v1.2.3"], root, output, preflight), 1);
    const written = stderr.join("");
    assert.include(written, "blocked: precondition unmet: rerere.enabled: unset");
    assert.include(written, "fix: git config --global rerere.enabled true");
    assert.notInclude(written, "dependencies installed");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("never falls back to resolving origin/hyprws itself", () => {
  const { root } = fixtureRepository();
  try {
    const { stderr, output } = collector();
    assert.strictEqual(
      run(["--tag", "v1.2.3"], root, output, { preflight: () => passingPreflight(null) }),
      1,
    );
    assert.include(stderr.join(""), "no freshly fetched origin/hyprws head");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
