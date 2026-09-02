// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  CHECK_DEPENDENCIES,
  CHECK_MIRROR,
  CHECK_ORIGIN_FETCH,
  CHECK_ORIGIN_REMOTE,
  CHECK_RERERE,
  CHECK_UPSTREAM_REMOTE,
  renderReport,
  run,
  runPreflight,
  TAG_PINNED_CHECKS,
  unmetChecks,
  unmetRequired,
  type CommandResult,
  type PreflightEnv,
} from "./fork-preflight.ts";

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const DRIFTED = "c".repeat(40);

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });

const healthy = (): Record<string, CommandResult> => ({
  "remote get-url origin": ok("git@github.com:RSI-Software/t3code-hyprws.git\n"),
  "remote get-url upstream": ok("https://github.com/pingdotgg/t3code.git\n"),
  "config --get rerere.enabled": ok("true\n"),
  "fetch origin +refs/heads/hyprws:refs/remotes/origin/hyprws": ok(),
  "rev-parse origin/hyprws^{commit}": ok(`${HEAD}\n`),
  "fetch upstream --tags": ok(),
  "fetch origin +refs/heads/main:refs/remotes/origin/main": ok(),
  "rev-parse origin/main^{commit}": ok(`${MAIN}\n`),
  "rev-parse upstream/main^{commit}": ok(`${MAIN}\n`),
});

interface Harness {
  readonly env: PreflightEnv;
  readonly calls: ReadonlyArray<string>;
}

const harness = (
  overrides: Record<string, CommandResult> = {},
  dependenciesInstalled = true,
): Harness => {
  const table: Record<string, CommandResult> = { ...healthy(), ...overrides };
  const calls: Array<string> = [];
  return {
    calls,
    env: {
      git: (args) => {
        const key = args.join(" ");
        calls.push(key);
        return table[key] ?? failed(`unscripted git call: ${key}`);
      },
      directoryExists: () => dependenciesInstalled,
    },
  };
};

const named = (report: ReturnType<typeof runPreflight>, name: string) =>
  report.checks.find((check) => check.name === name);

it("reports every precondition met and hands back the fetched head", () => {
  const { env } = harness();
  const report = runPreflight(env);
  assert.deepStrictEqual(unmetChecks(report), []);
  assert.strictEqual(report.originHyprwsSha, HEAD);
  assert.strictEqual(report.checks.length, 6);
  assert.include(renderReport(report), "preflight passed: 6 preconditions met");
});

it("reads origin/hyprws only after this run fetched it", () => {
  const { env, calls } = harness();
  runPreflight(env);
  const fetched = calls.indexOf("fetch origin +refs/heads/hyprws:refs/remotes/origin/hyprws");
  const read = calls.indexOf("rev-parse origin/hyprws^{commit}");
  assert.isAbove(fetched, -1);
  assert.isAbove(read, fetched);
});

it("names an unset rerere.enabled with the command that sets it", () => {
  const report = runPreflight(harness({ "config --get rerere.enabled": failed("") }).env);
  assert.deepStrictEqual(
    unmetChecks(report).map((check) => check.name),
    [CHECK_RERERE],
  );
  assert.strictEqual(named(report, CHECK_RERERE)?.detail, "unset");
  assert.strictEqual(
    named(report, CHECK_RERERE)?.remedy,
    "git config --global rerere.enabled true",
  );
});

it("names a remote that points somewhere else and skips the fetches that need it", () => {
  const { env, calls } = harness({
    "remote get-url origin": ok("git@github.com:someone/else.git\n"),
  });
  const report = runPreflight(env);
  assert.deepStrictEqual(
    unmetChecks(report).map((check) => check.name),
    [CHECK_ORIGIN_REMOTE, CHECK_ORIGIN_FETCH, CHECK_MIRROR],
  );
  assert.include(named(report, CHECK_ORIGIN_REMOTE)?.detail ?? "", "someone/else");
  assert.strictEqual(report.originHyprwsSha, null);
  assert.deepStrictEqual(
    calls.filter((call) => call.startsWith("fetch")),
    [],
  );
});

it("names a missing upstream remote", () => {
  const report = runPreflight(harness({ "remote get-url upstream": failed("No such remote") }).env);
  assert.deepStrictEqual(
    unmetChecks(report).map((check) => check.name),
    [CHECK_UPSTREAM_REMOTE, CHECK_MIRROR],
  );
});

it("names a stale main mirror with both shas", () => {
  const report = runPreflight(
    harness({ "rev-parse origin/main^{commit}": ok(`${DRIFTED}\n`) }).env,
  );
  assert.deepStrictEqual(
    unmetChecks(report).map((check) => check.name),
    [CHECK_MIRROR],
  );
  const detail = named(report, CHECK_MIRROR)?.detail ?? "";
  assert.include(detail, DRIFTED.slice(0, 12));
  assert.include(detail, MAIN.slice(0, 12));
});

it("treats a failed origin fetch as unproved freshness, not a usable head", () => {
  const report = runPreflight(
    harness({
      "fetch origin +refs/heads/hyprws:refs/remotes/origin/hyprws": failed(
        "Could not read from remote",
      ),
    }).env,
  );
  assert.strictEqual(report.originHyprwsSha, null);
  assert.include(named(report, CHECK_ORIGIN_FETCH)?.detail ?? "", "Could not read from remote");
});

it("names absent dependencies and the install command", () => {
  const report = runPreflight(harness({}, false).env);
  assert.deepStrictEqual(
    unmetChecks(report).map((check) => check.name),
    [CHECK_DEPENDENCIES],
  );
  assert.strictEqual(named(report, CHECK_DEPENDENCIES)?.remedy, "vp i");
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

it("exits 2 on an unknown option and 0 on help", () => {
  const usage = collector();
  assert.strictEqual(run(["--nope"], process.cwd(), usage.output), 2);
  assert.include(usage.stderr.join(""), "unknown option: --nope");

  const help = collector();
  assert.strictEqual(run(["--help"], process.cwd(), help.output), 0);
  assert.include(help.stdout.join(""), "Usage: vp run fork:preflight");
});

it("reports a drifted mirror without requiring it for a tag-pinned caller", () => {
  const report = runPreflight(
    harness({ "rev-parse origin/main^{commit}": ok(`${DRIFTED}\n`) }).env,
  );
  assert.deepStrictEqual(
    unmetChecks(report).map((check) => check.name),
    [CHECK_MIRROR],
  );
  assert.deepStrictEqual(unmetRequired(report, TAG_PINNED_CHECKS), []);
  const rendered = renderReport(report, TAG_PINNED_CHECKS);
  assert.include(rendered, `noted ${CHECK_MIRROR}`);
  assert.include(rendered, `not required here: ${CHECK_MIRROR}`);
  assert.notInclude(rendered, "unmet preconditions:");
});

it("exits 1 against a repository with no fork remotes", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-preflight-"));
  try {
    NodeChildProcess.execFileSync("git", ["init", "-b", "fixture"], { cwd: root });
    const { stdout, output } = collector();
    assert.strictEqual(run([], root, output), 1);
    const written = stdout.join("");
    assert.include(written, `unmet ${CHECK_ORIGIN_REMOTE}`);
    assert.include(written, `unmet ${CHECK_UPSTREAM_REMOTE}`);
    assert.include(written, "unmet preconditions:");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
