// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import type { PreflightReport } from "./fork-preflight.ts";
import {
  type CheckoutBinding,
  inspectRecord,
  parseArgs,
  run,
  UsageError,
} from "./fork-sync-gate.ts";

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

interface RecordOptions extends Partial<CheckoutBinding> {
  readonly sanity?: string;
}

const record = (options: RecordOptions = {}) => {
  const values = { ...DEFAULT_BINDING, sanity: "donjor 2026-08-27", ...options };
  return `# Rehearsal\n
## Header\n
- Target: \`${values.targetTag}@${values.targetSha}\`\n
- \`expected_old\`: \`${values.expectedOld}\`\n
- Rebased head: \`${values.rebasedHead}\`\n
- Stack size: \`${values.stackSize}\` fork commits\n
- Human sanity: ${values.sanity}\n`;
};

const binding = (overrides: Partial<CheckoutBinding> = {}): CheckoutBinding => ({
  ...DEFAULT_BINDING,
  ...overrides,
});

it("keeps stable-only as the default and opts into nightly tags", () => {
  assert.deepStrictEqual(parseArgs(["--tag", "v1.2.3", "--record", "/tmp/record.md"]), {
    tag: "v1.2.3",
    recordPath: "/tmp/record.md",
    allowNightly: false,
  });
  assert.deepStrictEqual(
    parseArgs([
      "--allow-nightly",
      "--record",
      "/tmp/record.md",
      "--tag",
      "v1.2.3-nightly.20260828.4",
    ]),
    {
      tag: "v1.2.3-nightly.20260828.4",
      recordPath: "/tmp/record.md",
      allowNightly: true,
    },
  );
  assert.throws(
    () => parseArgs(["--tag", "v1.2.3-nightly.20260828.4", "--record", "/tmp/record.md"]),
    UsageError,
  );
  assert.throws(
    () => parseArgs(["--tag", "v1.2.3-nightly.4", "--record", "/tmp/record.md", "--allow-nightly"]),
    UsageError,
  );
  assert.throws(() => parseArgs(["--tag", "../../tmp", "--record", "/tmp/record.md"]), UsageError);
  assert.throws(() => parseArgs(["--tag", "v1.2.3"]), UsageError);
  assert.throws(() => parseArgs([]), UsageError);
});

it("requires a matching expected_old and a login plus calendar date", () => {
  assert.deepStrictEqual(inspectRecord(record(), binding()), []);
  assert.deepStrictEqual(inspectRecord(record({ expectedOld: "d".repeat(40) }), binding()), [
    `expected_old mismatch: record ${"d".repeat(40)}, origin/hyprws ${SHA}`,
  ]);
  assert.deepStrictEqual(inspectRecord(record({ sanity: "absent" }), binding()), [
    'missing Human sanity mark: expected "Human sanity: <login> YYYY-MM-DD"',
  ]);
  assert.deepStrictEqual(inspectRecord(record({ sanity: "donjor 2026-02-30" }), binding()), [
    'missing Human sanity mark: expected "Human sanity: <login> YYYY-MM-DD"',
  ]);
  assert.deepStrictEqual(
    inspectRecord(
      `# Rehearsal\n\n## Notes\n\n- \`expected_old\`: \`${SHA}\`\n- Human sanity: donjor 2026-08-27\n`,
      binding(),
    ),
    [
      "record header missing `expected_old` full SHA",
      "record header missing Target tag and full SHA",
      "record header missing Rebased head full SHA",
      "record header missing Stack size",
      'missing Human sanity mark: expected "Human sanity: <login> YYYY-MM-DD"',
    ],
  );
});

it("refuses when the record Target differs from the checkout target", () => {
  const recorded = `v1.2.3@${"d".repeat(40)}`;
  const observed = `v1.2.3@${TARGET_SHA}`;
  assert.deepStrictEqual(inspectRecord(record({ targetSha: "d".repeat(40) }), binding()), [
    `Target mismatch: record ${recorded}, checkout ${observed}`,
  ]);
});

it("refuses when the record Rebased head differs from checkout HEAD", () => {
  const recorded = "d".repeat(40);
  assert.deepStrictEqual(inspectRecord(record({ rebasedHead: recorded }), binding()), [
    `Rebased head mismatch: record ${recorded}, checkout ${REBASED_HEAD}`,
  ]);
});

it("refuses when the record Stack size differs from the checkout count", () => {
  assert.deepStrictEqual(inspectRecord(record({ stackSize: "8" }), binding()), [
    "Stack size mismatch: record 8, checkout 7",
  ]);
});

it("accepts a record whose target, head, and stack size match the checkout", () => {
  assert.deepStrictEqual(inspectRecord(record(), binding()), []);
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
  recordPath: string;
} => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-gate-"));
  const recordRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-record-"));
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
  const recordPath = NodePath.join(recordRoot, "v1.2.3.md");
  NodeFS.writeFileSync(
    recordPath,
    record({ targetSha, expectedOld: head, rebasedHead: head, stackSize }),
  );
  return { root, recordRoot, targetSha, head, stackSize, recordPath };
};

it("runs against an external record and the preflight's freshly fetched head", () => {
  const { root, recordRoot, targetSha, head, stackSize, recordPath } = fixtureRepository();
  try {
    const { stdout, stderr, output } = collector();
    const dependencies = { preflight: () => passingPreflight(head), git: gitDependency };
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--record", recordPath], root, output, dependencies),
      0,
    );
    assert.match(stdout.join(""), /^ready: v1\.2\.3 apply gate passed/);

    NodeFS.writeFileSync(
      recordPath,
      record({
        targetSha,
        expectedOld: head,
        rebasedHead: head,
        stackSize,
        sanity: "absent",
      }),
    );
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--record", recordPath], root, output, dependencies),
      1,
    );
    assert.include(stderr.join(""), "missing Human sanity mark");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(recordRoot, { recursive: true, force: true });
  }
});

it("refuses a record inside the replayed repository", () => {
  const { root, recordRoot, targetSha, head, stackSize } = fixtureRepository();
  const recordPath = NodePath.join(root, "rehearsal.md");
  NodeFS.writeFileSync(
    recordPath,
    record({ targetSha, expectedOld: head, rebasedHead: head, stackSize }),
  );
  try {
    const { stderr, output } = collector();
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--record", recordPath], root, output, {
        preflight: () => passingPreflight(head),
        git: gitDependency,
      }),
      1,
    );
    assert.include(stderr.join(""), "rehearsal record must be outside the repository");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(recordRoot, { recursive: true, force: true });
  }
});

it("refuses on an unmet precondition and names it before reading the record", () => {
  const { root, recordRoot, recordPath } = fixtureRepository();
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
      run(["--tag", "v1.2.3", "--record", recordPath], root, output, preflight),
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

it("never falls back to resolving origin/hyprws itself", () => {
  const { root, recordRoot, recordPath } = fixtureRepository();
  try {
    const { stderr, output } = collector();
    assert.strictEqual(
      run(["--tag", "v1.2.3", "--record", recordPath], root, output, {
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
