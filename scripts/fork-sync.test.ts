// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Temporary report fixtures use Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  decisionSurface,
  execute,
  gateVerificationEnv,
  identifyRerereResolvedPaths,
  lockDriftClass,
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  rehearsalConflictRows,
  rehearsalConflictStop,
  rehearsalRebaseArgs,
  renderRecord,
  run,
  validateReport,
  validateSignedRecord,
  type CommandResult,
  type CommandRunner,
  type SyncReport,
} from "./fork-sync.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const fixtureRoot = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-test-"));
  NodeChildProcess.execFileSync("git", ["init", "-b", "fixture"], { cwd: root });
  return root;
};

const report = (root: string, overrides: Partial<SyncReport> = {}): SyncReport => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-report-"));
  return {
    schemaVersion: 1,
    stage: "listed",
    repositoryRoot: root,
    reportPath: NodePath.join(directory, "report.json"),
    recordPath: NodePath.join(directory, "record.md"),
    issue: { number: 352, blockingSha: A, title: "blocked" },
    candidates: [{ tag: "v1.2.3", sha: B }],
    conflicts: [],
    verification: [],
    ...overrides,
  };
};

class FakeRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }> = [];
  readonly responses = new Map<string, CommandResult>();
  fallback: CommandResult = { status: 0, stdout: "", stderr: "" };

  key(command: string, args: ReadonlyArray<string>): string {
    return `${command} ${args.join(" ")}`;
  }
  set(command: string, args: ReadonlyArray<string>, result: Partial<CommandResult>): void {
    this.responses.set(this.key(command, args), { status: 0, stdout: "", stderr: "", ...result });
  }
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    _input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult {
    this.calls.push({ command, args, cwd, ...(env === undefined ? {} : { env }) });
    return this.responses.get(this.key(command, args)) ?? this.fallback;
  }
}

const issueJson = JSON.stringify([
  { number: 352, title: "blocked", body: `body\n<!-- blocking-sha:${A} -->` },
]);

it("writes a listed report without accepting or inferring a target", () => {
  const root = fixtureRoot();
  const output = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-out-")),
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
      "rebase-blocked",
      "-R",
      "RSI-Software/t3code-hyprws",
      "--json",
      "number,title,body",
    ],
    { stdout: issueJson },
  );
  runner.set("git", ["rev-list", "--first-parent", "--reverse", "upstream/main"], {
    stdout: `${A}\n${B}\n`,
  });
  runner.set(
    "git",
    [
      "for-each-ref",
      "--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)",
      "refs/tags/v*",
    ],
    { stdout: `v1.2.3\t${B}\t\nv1.2.4-nightly.20260831.2\t${C}\t\n` },
  );

  try {
    const listed = execute(["unblock-list", "--output", output], root, runner);
    assert.strictEqual(listed.stage, "listed");
    assert.deepStrictEqual(listed.candidates, [{ tag: "v1.2.3", sha: B }]);
    assert.isUndefined(listed.target);
    assert.strictEqual(
      validateReport(JSON.parse(NodeFS.readFileSync(output, "utf8"))).stage,
      "listed",
    );
    assert.throws(
      () => execute(["unblock-list", "--target", "v1.2.3"], root, runner),
      /unknown option/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(output), { recursive: true, force: true });
  }
});

it("orients only to a tag carried by the previous report", () => {
  const root = fixtureRoot();
  const listed = report(root);
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  try {
    assert.throws(
      () =>
        execute(
          ["unblock-orient", "--report", listed.reportPath, "--target", "v9.9.9"],
          root,
          runner,
        ),
      /was not offered/,
    );

    runner.set(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "rebase-blocked",
        "-R",
        "RSI-Software/t3code-hyprws",
        "--json",
        "number,title,body",
      ],
      { stdout: issueJson },
    );
    runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${B}\n` });
    runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
    runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
    runner.set("node", ["scripts/fork-orient.ts", "--target", "v1.2.3"], {
      stdout:
        "## Retire candidates\n  [keep] feat(web): preserve fork behavior (workspace-files)\n",
    });
    const oriented = execute(
      ["unblock-orient", "--report", listed.reportPath, "--target", "v1.2.3"],
      root,
      runner,
    );
    assert.strictEqual(oriented.stage, "oriented");
    assert.deepStrictEqual(oriented.source, { sha: C, expectedOld: C, sharedBase: A });
    assert.deepStrictEqual(oriented.conflicts, []);
    assert.deepStrictEqual(oriented.orientationDecisions, [
      {
        verdict: "keep",
        subject: "feat(web): preserve fork behavior",
        domain: "workspace-files",
      },
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("carries orientation overlap and every retirement verdict into structured state", () => {
  const orientation = [
    "## Automerged overlap",
    "Automerged files:",
    "  - apps/web/src/a.ts",
    "  - package.json",
    "",
    "## Retire candidates",
    "  [candidate] fix(web): review upstream overlap (project-windows)",
    "  [keep] feat(web): keep fork behavior (workspace-files)",
    "  [retire] fix(server): use upstream behavior (fork-meta)",
    "  [partial] feat(desktop): retain one seam (custom-agents)",
    "",
  ].join("\n");
  assert.deepStrictEqual(orientationTouchedPaths(orientation), [
    "apps/web/src/a.ts",
    "package.json",
  ]);
  assert.deepStrictEqual(orientationDecisionRows(orientation), [
    {
      verdict: "candidate",
      subject: "fix(web): review upstream overlap",
      domain: "project-windows",
    },
    {
      verdict: "keep",
      subject: "feat(web): keep fork behavior",
      domain: "workspace-files",
    },
    {
      verdict: "retire",
      subject: "fix(server): use upstream behavior",
      domain: "fork-meta",
    },
    {
      verdict: "partial",
      subject: "feat(desktop): retain one seam",
      domain: "custom-agents",
    },
  ]);
});

it("refuses a rehearsal lane collision for the exact target and source", () => {
  const root = fixtureRoot();
  const oriented = report(root, {
    stage: "oriented",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
  });
  NodeFS.writeFileSync(oriented.reportPath, JSON.stringify(oriented));
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/rehearse/v1.2.3-from-${C.slice(0, 12)}`],
    { status: 0 },
  );
  try {
    assert.throws(
      () => execute(["unblock-rehearse", "--report", oriented.reportPath], root, runner),
      /lane already exists/,
    );
    assert.isFalse(runner.calls.some(({ command }) => command === "wt"));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(oriented.reportPath), { recursive: true, force: true });
  }
});

it("names the in-flight commit and every conflicted path in the rehearsal stop", () => {
  assert.strictEqual(
    rehearsalConflictStop(
      "/tmp/report.json",
      "/tmp/record.md",
      { sha: C, subject: "fix(web): preserve scoped behavior" },
      ["apps/web/src/a.ts", "packages/shared/src/b.ts"],
    ),
    [
      "/tmp/report.json",
      `Stop. Rebase conflict in fix(web): preserve scoped behavior (${C.slice(0, 12)}).`,
      "Conflicted paths:",
      "  - apps/web/src/a.ts",
      "  - packages/shared/src/b.ts",
      "Resolve and stage non-generated files, complete every TODO row in /tmp/record.md, then rerun unblock-rehearse.",
      "",
    ].join("\n"),
  );
});

it("asks for nothing when the only conflict is the regenerated lockfile", () => {
  const stop = rehearsalConflictStop(
    "/tmp/report.json",
    "/tmp/record.md",
    { sha: C, subject: "chore(deps): bump upstream" },
    ["pnpm-lock.yaml"],
  );
  assert.strictEqual(
    stop,
    [
      "/tmp/report.json",
      `Stop. Rebase conflict in chore(deps): bump upstream (${C.slice(0, 12)}).`,
      "Conflicted paths:",
      "  - pnpm-lock.yaml (generated)",
      "Nothing to resolve or record. Rerun unblock-rehearse; it restores HEAD, regenerates the lockfile, and continues.",
      "",
    ].join("\n"),
  );
  assert.notInclude(stop, "TODO row");
  assert.notInclude(stop, "Resolve and stage");
  assert.strictEqual(
    rehearsalConflictStop(
      "/tmp/report.json",
      "/tmp/record.md",
      { sha: C, subject: "chore(deps): bump upstream" },
      ["pnpm-lock.yaml"],
      ["pnpm-lock.yaml"],
    ),
    [
      "/tmp/report.json",
      `Stop. Rebase conflict in chore(deps): bump upstream (${C.slice(0, 12)}).`,
      "Conflicted paths:",
      "  - pnpm-lock.yaml (generated; rerere's recorded resolution is discarded)",
      "Nothing to resolve or record. Rerun unblock-rehearse; it restores HEAD, regenerates the lockfile, and continues.",
      "",
    ].join("\n"),
  );
});

it("keeps the resolve-and-record stop when a generated path conflicts alongside a source file", () => {
  const stop = rehearsalConflictStop(
    "/tmp/report.json",
    "/tmp/record.md",
    { sha: C, subject: "fix(web): preserve scoped behavior" },
    ["pnpm-lock.yaml", "apps/web/src/a.ts"],
  );
  assert.include(
    stop,
    "Resolve and stage non-generated files, complete every TODO row in /tmp/record.md, then rerun unblock-rehearse.",
  );
  assert.include(stop, "  - pnpm-lock.yaml\n");
});

it("enables rerere without staging its reused resolutions", () => {
  assert.deepStrictEqual(rehearsalRebaseArgs(["rebase", B]), [
    "-c",
    "core.commentChar=auto",
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoupdate=false",
    "rebase",
    B,
  ]);
  assert.deepStrictEqual(
    identifyRerereResolvedPaths(
      ["apps/web/src/reused.ts", "apps/web/src/unresolved.ts"],
      ["apps/web/src/unresolved.ts"],
    ),
    ["apps/web/src/reused.ts"],
  );
});

it("discloses rerere reuse in the stop and conflict record row", () => {
  const commit = { sha: C, subject: "fix(web): preserve scoped behavior", domain: "fork-meta" };
  const conflicts = ["apps/web/src/reused.ts", "apps/web/src/unresolved.ts"];
  const rerereResolved = ["apps/web/src/reused.ts"];
  const stop = rehearsalConflictStop(
    "/tmp/report.json",
    "/tmp/record.md",
    commit,
    conflicts,
    rerereResolved,
  );
  assert.include(
    stop,
    "apps/web/src/reused.ts (rerere reused a recorded resolution; review before staging)",
  );
  assert.include(
    stop,
    "Review and stage rerere-resolved files; resolve and stage remaining non-generated files",
  );
  const reusedRow = rehearsalConflictRows(commit, conflicts, rerereResolved).find(
    ({ path }) => path === "apps/web/src/reused.ts",
  );
  assert.deepInclude(reusedRow, {
    path: "apps/web/src/reused.ts",
    class: "TODO",
    resolution: "review rerere's recorded resolution and stage",
    agentSafe: "TODO",
  });
});

it("renders and parses the record schema including conflict judgement", () => {
  const root = fixtureRoot();
  const state = report(root, {
    stage: "conflicts",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    conflicts: [
      {
        commit: C,
        subject: "fix(web): keep behavior (#352)",
        domain: "fork-meta",
        path: "apps/web/src/a.ts",
        class: "TODO",
        resolution: "TODO",
        agentSafe: "TODO",
      },
    ],
  });
  const rendered = renderRecord(state);
  assert.include(rendered, "## Header");
  assert.include(rendered, "## Conflicts");
  assert.include(rendered, "## Automerged overlap review");
  assert.include(rendered, "## Fork commits");
  assert.include(rendered, "## Silent seams");
  assert.include(rendered, "## Verification");
  assert.include(rendered, "## Grounding");
  const edited = rendered.replace(
    "| TODO | TODO | TODO |",
    "| seam-moved | preserve upstream hook | yes — tested |",
  );
  assert.deepInclude(parseConflictRows(edited), {
    commit: C.slice(0, 12),
    subject: "fix(web): keep behavior (#352)",
    domain: "fork-meta",
    path: "apps/web/src/a.ts",
    class: "seam-moved",
    resolution: "preserve upstream hook",
    agentSafe: "yes — tested",
  });
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("round-trips escaped pipes and backslashes in conflict cells", () => {
  const root = fixtureRoot();
  const conflict = {
    commit: C,
    subject: "fix(web): preserve a | b and \\q",
    domain: "fork-meta",
    path: "apps/web/src/a|b\\q.ts",
    class: "seam-moved" as const,
    resolution: "keep left | right and \\q",
    agentSafe: "yes | covered by C:\\tests",
  };
  const rendered = renderRecord(
    report(root, {
      stage: "conflicts",
      conflicts: [conflict],
    }),
  );
  assert.include(
    rendered,
    "Escaped pipes are accepted in Subject, File, Resolution, and Agent-safe cells (`\\|`)",
  );
  assert.deepStrictEqual(parseConflictRows(rendered), [{ ...conflict, commit: C.slice(0, 12) }]);
  assert.throws(
    () => parseConflictRows(rendered.replace("keep left \\| right", "keep left \\q right")),
    /invalid conflict Resolution cell: unsupported escape \\q/,
  );
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("distinguishes importer ownership drift from registry snapshot drift", () => {
  const base =
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    specifiers: {}\nsnapshots:\n  a: old\n";
  assert.strictEqual(lockDriftClass(base, base), "none");
  assert.strictEqual(lockDriftClass(base, base.replace("a: old", "a: new")), "snapshots");
  assert.strictEqual(
    lockDriftClass(base, base.replace("specifiers: {}", "specifiers: { x: 1 }")),
    "importers",
  );
});

it("round-trips orientation verdicts outside conflicts and selects them for Gate 4", () => {
  const root = fixtureRoot();
  const orientationDecisions = orientationDecisionRows(
    [
      "  [candidate] fix(web): review upstream overlap (project-windows)",
      "  [keep] feat(web): keep fork behavior (workspace-files)",
      "  [retire] fix(server): use upstream behavior (fork-meta)",
      "  [partial] feat(desktop): retain one seam (custom-agents)",
    ].join("\n"),
  );
  const record = renderRecord(report(root, { orientationDecisions }));

  const conflicts = record.split("## Conflicts\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
  assert.include(conflicts, "None.");
  assert.notInclude(conflicts, "orientation");
  assert.include(
    record,
    "| `fix(web): review upstream overlap` | project-windows | orientation: candidate; retire-candidate | TODO |",
  );
  assert.include(
    record,
    "| `feat(web): keep fork behavior` | workspace-files | orientation: keep | keep |",
  );
  assert.include(
    record,
    "| `fix(server): use upstream behavior` | fork-meta | orientation: retire | retire |",
  );
  assert.include(
    record,
    "| `feat(desktop): retain one seam` | custom-agents | orientation: partial | partial |",
  );

  const surface = decisionSurface(record);
  for (const subject of orientationDecisions.map(({ subject }) => subject)) {
    assert.include(surface, subject);
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("produces Gate 4 decisions structurally rather than with a typed rg command", () => {
  const record =
    "| Exact subject | Domain | Class summary | Action | Grounding claim |\n| --- | --- | --- | --- | --- |\n| `fix: one` | fork-meta | conflict; retire-candidate because upstream moved | retire | n/a |\n| `fix: two` | web | human | keep | claim |\nGrounding pending: desktop label";
  const surface = decisionSurface(record);
  assert.include(surface, "fix: one");
  assert.include(surface, "fix: two");
  assert.include(surface, "Grounding pending: desktop label");
});

it("requires signed decisions and calls the existing sync gate before apply", () => {
  const root = fixtureRoot();
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/v1.2.3", worktree: root },
    installedHead: B,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  const unsigned = renderRecord(checked);
  assert.throws(() => validateSignedRecord(unsigned, checked), /missing Human sanity/);
  const signed = unsigned.replace("Human sanity: absent", "Human sanity: donjor 2026-09-01");
  NodeFS.writeFileSync(checked.recordPath, signed);
  const runner = new FakeRunner();
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "gh",
    [
      "issue",
      "comment",
      "352",
      "-R",
      "RSI-Software/t3code-hyprws",
      "--body-file",
      checked.recordPath,
    ],
    { stdout: "https://example.test/comment\n" },
  );
  try {
    const applied = execute(
      ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
      root,
      runner,
    );
    assert.strictEqual(applied.stage, "applied");
    const gate = runner.calls.find(
      ({ command, args }) => command === "vp" && args.includes("fork:sync-gate"),
    );
    assert.isDefined(gate);
    const push = runner.calls.find(
      ({ command, args }) => command === "git" && args.includes("push"),
    );
    assert.include(push?.args ?? [], `--force-with-lease=refs/heads/hyprws:${C}`);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("returns usage status for an unknown verb", () => {
  assert.strictEqual(run(["nope"], process.cwd(), new FakeRunner()), 2);
});

// The scan typechecks the replayed head, so a tree installed before the replay carried its
// manifests reads exactly like a fresh one. Ordering is the whole guarantee.
const checkedRun = (): {
  runner: FakeRunner;
  root: string;
  worktree: string;
  reportPath: string;
} => {
  const root = fixtureRoot();
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  const lock = "lockfileVersion: '9.0'\nimporters:\n  .:\n    specifiers: {}\n";
  NodeFS.writeFileSync(NodePath.join(worktree, "pnpm-lock.yaml"), lock);
  const messages = "feat: one\x1e";
  const replayed = report(root, {
    stage: "replayed",
    target: { tag: "v1.2.3", sha: B },
    lane: { branch: "rehearse/v1.2.3-from-cccccccccccc", worktree },
    originalMessages: messages,
    originalCount: 1,
  });
  NodeFS.writeFileSync(replayed.reportPath, JSON.stringify(replayed));

  const runner = new FakeRunner();
  runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
    stdout: "1\n",
  });
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${B}..HEAD`,
    ],
    { stdout: messages },
  );
  runner.set("git", ["-c", "core.commentChar=auto", "show", "HEAD:pnpm-lock.yaml"], {
    stdout: lock,
  });
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${A}\n` });
  execute(["unblock-check", "--report", replayed.reportPath], root, runner);
  return { runner, root, worktree, reportPath: replayed.reportPath };
};

const order = (runner: FakeRunner, command: string, args: ReadonlyArray<string>): number =>
  runner.calls.findIndex(
    (call) => call.command === command && call.args.join(" ") === args.join(" "),
  );

it("installs the replayed tree before the scan that typechecks it", () => {
  const { runner, root, worktree } = checkedRun();
  try {
    const install = order(runner, "vp", ["i"]);
    const scan = order(runner, "vp", ["run", "--no-cache", "fork:scan", "--target", "v1.2.3"]);
    assert.isAbove(install, -1);
    assert.isAbove(scan, install);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

it("bypasses the task cache and records the executed Gate 3 commands", () => {
  const { runner, root, worktree, reportPath } = checkedRun();
  try {
    const cachedTasks = runner.calls.filter(
      ({ command, args }) => command === "vp" && args[0] === "run",
    );
    assert.lengthOf(cachedTasks, 4);
    for (const call of cachedTasks) assert.strictEqual(call.args[1], "--no-cache");

    const checked = validateReport(JSON.parse(NodeFS.readFileSync(reportPath, "utf8")));
    assert.deepInclude(checked.verification, {
      command: "vp run --no-cache test",
      result: "passed",
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

it("scrubs package-manager, Vite+ bootstrap, and Electron state from Gate 3 checks", () => {
  const preserved = { PATH: "/bin", HOME: "/home/example" };
  const scrubbed = {
    NPM_CONFIG_REGISTRY: "https://registry.example.test",
    VP_ENV_USE_EVAL_ENABLE: "1",
    VP_NODE_DIST_MIRROR: "https://node.example.test",
    VP_NODE_SKIP_SIGNATURE_VERIFY: "1",
    VP_NODE_VERSION: "24.20.0",
    npm_config_registry: "https://registry.example.test",
    npm_lifecycle_event: "fork:sync",
    ELECTRON_RUN_AS_NODE: "1",
  };
  assert.deepStrictEqual(gateVerificationEnv({ ...preserved, ...scrubbed }), preserved);

  const { runner, root, worktree } = checkedRun();
  try {
    const checks = runner.calls.filter(
      ({ command, args }) =>
        command === "vp" && (args[0] === "check" || (args[0] === "run" && args[1] !== undefined)),
    );
    assert.lengthOf(checks, 5);
    for (const call of checks) {
      assert.isDefined(call.env);
      for (const key of Object.keys(scrubbed)) {
        assert.notProperty(call.env, key);
      }
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

it("neutralises the comment char on every rehearsal git call, not one shell", () => {
  const { runner, root, worktree } = checkedRun();
  try {
    const rehearsal = runner.calls.filter(
      (call) => call.command === "git" && call.cwd === worktree,
    );
    assert.isAbove(rehearsal.length, 3);
    for (const call of rehearsal) {
      assert.deepStrictEqual(call.args.slice(0, 2), ["-c", "core.commentChar=auto"]);
      assert.strictEqual(call.env?.GIT_CONFIG_COUNT, "1");
      assert.strictEqual(call.env?.GIT_CONFIG_KEY_0, "core.commentChar");
      assert.strictEqual(call.env?.GIT_CONFIG_VALUE_0, "auto");
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});
