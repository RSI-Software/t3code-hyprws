// @effect-diagnostics nodeBuiltinImport:off - Stable report fixtures use Node temporary directories.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  executeStable,
  validateStableReport,
  type StableCandidate,
  type StableReport,
} from "./fork-sync-stable.ts";
import { run as runForkSync } from "./fork-sync.ts";
import type { CommandResult, CwdCommandRunner as CommandRunner } from "./lib/fork-command.ts";

const SHA = "a".repeat(40);
const REPOSITORY = "RSI-Software/t3code-hyprws";

class FakeRunner implements CommandRunner {
  readonly calls: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }> = [];
  readonly responses = new Map<string, CommandResult>();
  fallback: CommandResult = { status: 0, stdout: "", stderr: "" };

  key(command: string, args: ReadonlyArray<string>): string {
    return `${command} ${args.join(" ")}`;
  }

  set(command: string, args: ReadonlyArray<string>, result: Partial<CommandResult>): void {
    this.responses.set(this.key(command, args), { status: 0, stdout: "", stderr: "", ...result });
  }

  run(command: string, args: ReadonlyArray<string>, cwd: string): CommandResult {
    this.calls.push({ command, args, cwd });
    return this.responses.get(this.key(command, args)) ?? this.fallback;
  }
}

const candidate: StableCandidate = {
  issue: 355,
  name: "v1.2.3-hyprws",
  title: "Stable candidate v1.2.3-hyprws",
  body: "Snapshot `release/v1.2.3-hyprws`.\n<!-- hyprws-stable-candidate: v1.2.3-hyprws -->",
  branch: "release/v1.2.3-hyprws",
};

const issueJson = (state = "OPEN"): string =>
  JSON.stringify({
    number: candidate.issue,
    title: candidate.title,
    body: candidate.body,
    state,
  });

const reportFixture = (root: string, overrides: Partial<StableReport> = {}): StableReport => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stable-report-test-"));
  return {
    schemaVersion: 1,
    stage: "stable-listed",
    repositoryRoot: root,
    reportPath: NodePath.join(directory, "report.json"),
    candidates: [candidate],
    verification: [],
    ...overrides,
  };
};

it("stable-list reads every candidate into an external report without accepting a selection", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stable-list-root-"));
  const output = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stable-list-output-")),
    "report.json",
  );
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "--show-toplevel"], { stdout: `${root}\n` });
  runner.set(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "release",
      "--limit",
      "1000",
      "-R",
      REPOSITORY,
      "--json",
      "number,title,body",
    ],
    {
      stdout: JSON.stringify([
        { number: candidate.issue, title: candidate.title, body: candidate.body },
        { number: 999, title: "UAT v1.2.3-hyprws", body: "human test" },
      ]),
    },
  );

  assert.strictEqual(runForkSync(["stable-list", "--output", output], root, runner), 0);
  const listed = validateStableReport(JSON.parse(NodeFS.readFileSync(output, "utf8")));
  assert.strictEqual(listed.stage, "stable-listed");
  assert.deepStrictEqual(listed.candidates, [candidate]);
  assert.throws(
    () => executeStable(["stable-list", "--issue", "355"], root, runner),
    /unknown argument/,
  );
});

it("stable-prepare binds the selected snapshot, runs the release checks, and renders UAT", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stable-prepare-root-"));
  const lane = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stable-prepare-lane-"));
  const listed = reportFixture(root);
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  runner.set(
    "gh",
    ["issue", "view", "355", "-R", REPOSITORY, "--json", "number,title,body,state"],
    { stdout: issueJson() },
  );
  runner.set("git", ["rev-parse", "origin/release/v1.2.3-hyprws^{commit}"], {
    stdout: `${SHA}\n`,
  });
  runner.set("git", ["show-ref", "--verify", "--quiet", "refs/heads/cut/v1.2.3-hyprws"], {
    status: 1,
  });
  runner.set(
    "wt",
    [
      "switch",
      "--create",
      "cut/v1.2.3-hyprws",
      "--base",
      "origin/release/v1.2.3-hyprws",
      "--no-cd",
      "--format",
      "json",
      "--yes",
    ],
    { stdout: JSON.stringify({ worktree_path: lane }) },
  );
  runner.set("git", ["rev-parse", "HEAD"], { stdout: `${SHA}\n` });
  runner.set("git", ["tag", "--list", "v*-hyprws.*"], {
    stdout: "v1.2.3-hyprws.1\nv1.2.3-hyprws.3\nv1.2.4-hyprws.8\n",
  });
  runner.set("git", ["show-ref", "--verify", "--quiet", "refs/tags/v1.2.3-hyprws.4"], {
    status: 1,
  });
  runner.set("git", ["ls-remote", "--exit-code", "--tags", "origin", "refs/tags/v1.2.3-hyprws.4"], {
    status: 2,
  });

  const prepared = executeStable(
    ["stable-prepare", "--report", listed.reportPath, "--issue", "355"],
    root,
    runner,
  );

  assert.strictEqual(prepared.stage, "stable-prepared");
  assert.deepStrictEqual(prepared.snapshot, { branch: candidate.branch, sha: SHA });
  assert.deepStrictEqual(prepared.release, {
    tag: "v1.2.3-hyprws.4",
    priorTags: ["v1.2.3-hyprws.1", "v1.2.3-hyprws.3"],
  });
  for (const args of [
    ["i"],
    ["run", "fork:delta", "--check"],
    ["check"],
    ["run", "typecheck"],
    ["run", "test"],
  ]) {
    assert.isTrue(
      runner.calls.some((call) => call.command === "vp" && call.args.join(" ") === args.join(" ")),
    );
  }
  assert.isTrue(
    runner.calls.some(
      (call) => call.command === "vp" && call.args.slice(0, 3).join(" ") === "run fork:uat --ref",
    ),
  );
});

it("stable-publish requires the exact go, revalidates create-only refs, and closes after assets", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stable-publish-root-"));
  const lane = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stable-publish-lane-"));
  const prepared = reportFixture(root, {
    stage: "stable-prepared",
    selected: candidate,
    snapshot: { branch: candidate.branch, sha: SHA },
    lane: { branch: "cut/v1.2.3-hyprws", worktree: lane },
    release: { tag: "v1.2.3-hyprws.4", priorTags: ["v1.2.3-hyprws.3"] },
    uatDraftPath: "/tmp/uat-v1.2.3-hyprws.md",
  });
  NodeFS.writeFileSync(prepared.reportPath, JSON.stringify(prepared));
  const runner = new FakeRunner();
  runner.set(
    "gh",
    ["issue", "view", "355", "-R", REPOSITORY, "--json", "number,title,body,state"],
    { stdout: issueJson() },
  );
  runner.set("git", ["rev-parse", "origin/release/v1.2.3-hyprws^{commit}"], {
    stdout: `${SHA}\n`,
  });
  runner.set("git", ["rev-parse", "HEAD"], { stdout: `${SHA}\n` });
  runner.set("git", ["show-ref", "--verify", "--quiet", "refs/tags/v1.2.3-hyprws.4"], {
    status: 1,
  });
  runner.set("git", ["ls-remote", "--exit-code", "--tags", "origin", "refs/tags/v1.2.3-hyprws.4"], {
    status: 2,
  });
  const runListCall = [
    "run",
    "list",
    "--workflow",
    "hyprws-release.yml",
    "--event",
    "push",
    "--limit",
    "20",
    "-R",
    REPOSITORY,
    "--json",
    "databaseId,headBranch",
    "--jq",
    'map(select(.headBranch == "v1.2.3-hyprws.4"))[0].databaseId // empty',
  ];
  runner.set("gh", runListCall, { stdout: "12345\n" });
  runner.set(
    "gh",
    [
      "release",
      "view",
      "v1.2.3-hyprws.4",
      "-R",
      REPOSITORY,
      "--json",
      "assets",
      "--jq",
      ".assets[].name",
    ],
    { stdout: "T3-Code.AppImage\nlatest-linux.yml\n" },
  );
  runner.set("gh", ["run", "view", "12345", "-R", REPOSITORY, "--json", "url", "--jq", ".url"], {
    stdout: "https://example.test/runs/12345\n",
  });

  assert.throws(
    () =>
      executeStable(
        ["stable-publish", "--report", prepared.reportPath, "--go", "yes"],
        root,
        runner,
      ),
    /must repeat the exact selected candidate/,
  );
  assert.isFalse(runner.calls.some((call) => call.command === "git" && call.args[0] === "tag"));
  const published = executeStable(
    ["stable-publish", "--report", prepared.reportPath, "--go", candidate.name],
    root,
    runner,
  );

  assert.strictEqual(published.stage, "stable-published");
  assert.deepStrictEqual(published.workflow, {
    runId: "12345",
    url: "https://example.test/runs/12345",
    assets: ["T3-Code.AppImage", "latest-linux.yml"],
  });
  const tag = runner.calls.find(
    (call) => call.command === "git" && call.args[0] === "tag" && call.args[1] === "-a",
  );
  assert.deepStrictEqual(tag?.args, [
    "tag",
    "-a",
    "v1.2.3-hyprws.4",
    SHA,
    "-m",
    "T3 Code hyprws 1.2.3-hyprws.4",
  ]);
  assert.isTrue(
    runner.calls.some(
      (call) =>
        call.command === "git" && call.args.join(" ") === "push origin refs/tags/v1.2.3-hyprws.4",
    ),
  );
  assert.isTrue(
    runner.calls.some(
      (call) => call.command === "wt" && call.args.join(" ") === "remove -D cut/v1.2.3-hyprws",
    ),
  );
  assert.isTrue(
    runner.calls.some(
      (call) => call.command === "gh" && call.args[0] === "issue" && call.args[1] === "close",
    ),
  );
});
