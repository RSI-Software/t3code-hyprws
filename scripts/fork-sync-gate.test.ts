// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { inspectRecord, parseArgs, run, UsageError } from "./fork-sync-gate.ts";

const SHA = "a".repeat(40);
const record = (expectedOld = SHA, sanity = "donjor 2026-08-27") => `# Rehearsal\n
## Header\n
- \`expected_old\`: \`${expectedOld}\`\n
- Human sanity: ${sanity}\n`;

it("accepts only one stable tag", () => {
  assert.deepStrictEqual(parseArgs(["--tag", "v1.2.3"]), { tag: "v1.2.3" });
  assert.throws(() => parseArgs(["--tag", "v1.2.3-nightly.4"]), UsageError);
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

it("runs against the repository record and live origin/hyprws ref", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-gate-"));
  try {
    git(root, ["init", "-b", "fixture"]);
    git(root, ["config", "user.name", "Test User"]);
    git(root, ["config", "user.email", "test@example.com"]);
    NodeFS.writeFileSync(NodePath.join(root, "README.md"), "fixture\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "fixture"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, ["update-ref", "refs/remotes/origin/hyprws", head]);

    const directory = NodePath.join(root, "docs/operations/fork-sync-records");
    NodeFS.mkdirSync(directory, { recursive: true });
    const path = NodePath.join(directory, "v1.2.3.md");
    NodeFS.writeFileSync(path, record(head));

    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const output = {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    };
    assert.strictEqual(run(["--tag", "v1.2.3"], root, output), 0);
    assert.match(stdout.join(""), /^ready: v1\.2\.3 apply gate passed/);

    NodeFS.writeFileSync(path, record(head, "absent"));
    assert.strictEqual(run(["--tag", "v1.2.3"], root, output), 1);
    assert.include(stderr.join(""), "missing Human sanity mark");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
