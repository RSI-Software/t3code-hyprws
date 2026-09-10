import { assert, it } from "@effect/vitest";

import { type CommandResult, type CwdCommandRunner } from "./fork-command.ts";
import {
  focusedTests,
  formatCommand,
  isVerifiablePath,
  repairCommitMessage,
  repairKind,
  runRepairs,
  touchedWorkspaces,
  verifyPlan,
} from "./fork-repairs.ts";

const present =
  (paths: ReadonlyArray<string>) =>
  (path: string): boolean =>
    paths.includes(path);

it("scopes the lane's repair to the workspaces and suites the replay touched", () => {
  assert.deepStrictEqual(
    touchedWorkspaces([
      "apps/web/src/window.ts",
      "apps/web/src/other.ts",
      "packages/contracts/src/settings.ts",
      "scripts/fork-sync.ts",
      "README.md",
      "apps",
    ]),
    ["apps/web", "packages/contracts", "scripts"],
  );
  assert.deepStrictEqual(
    focusedTests(
      "/root",
      ["apps/web/src/window.ts", "apps/web/src/orphan.ts", "scripts/fork-sync.test.ts"],
      present([
        "apps/web/src/window.test.ts",
        "apps/web/src/window.fork.test.ts",
        "scripts/fork-sync.test.ts",
      ]),
    ),
    [
      "apps/web/src/window.fork.test.ts",
      "apps/web/src/window.test.ts",
      "scripts/fork-sync.test.ts",
    ],
  );
});

it("keeps the formatter scoped to the resolved paths so a rebase stays continuable", () => {
  assert.isNull(formatCommand([]));
  assert.deepStrictEqual(formatCommand(["b.ts", "a.ts"]), {
    command: "vp",
    args: ["fmt", "--no-error-on-unmatched-pattern", "a.ts", "b.ts"],
  });
  // Nothing in the read-only half writes, so it cannot dirty the lane it verifies.
  assert.deepStrictEqual(
    verifyPlan("/root", ["apps/web/src/window.ts"], present(["apps/web/src/window.test.ts"])),
    [
      { command: "vp", args: ["run", "--filter", "./apps/web", "typecheck"] },
      { command: "vp", args: ["test", "run", "src/window.test.ts"], cwd: "apps/web" },
    ],
  );
});

it("runs each suite from its own workspace so it gets that workspace's test config", () => {
  assert.deepStrictEqual(
    verifyPlan(
      "/root",
      ["apps/web/src/window.test.ts", "scripts/build.test.ts", "packages/contracts/src/rpc.ts"],
      present([
        "apps/web/src/window.test.ts",
        "scripts/build.test.ts",
        "packages/contracts/src/rpc.test.ts",
      ]),
    ),
    [
      { command: "vp", args: ["run", "--filter", "./apps/web", "typecheck"] },
      { command: "vp", args: ["run", "--filter", "./packages/contracts", "typecheck"] },
      { command: "vp", args: ["run", "--filter", "./scripts", "typecheck"] },
      { command: "vp", args: ["test", "run", "src/window.test.ts"], cwd: "apps/web" },
      { command: "vp", args: ["test", "run", "src/rpc.test.ts"], cwd: "packages/contracts" },
      { command: "vp", args: ["test", "run", "build.test.ts"], cwd: "scripts" },
    ],
  );
});

const runnerFor = (results: ReadonlyMap<string, Partial<CommandResult>>): CwdCommandRunner => ({
  run(command, args): CommandResult {
    return {
      status: 0,
      stdout: "",
      stderr: "",
      ...(results.get([command, ...args].join(" ")) ?? {}),
    };
  },
});

it("separates a lane that cannot test from a replay that does not hold", () => {
  const plan = [
    { command: "vp", args: ["run", "--filter", "./apps/web", "typecheck"] },
    { command: "vp", args: ["test", "run", "apps/web/src/window.test.ts"] },
  ];
  const passed = runRepairs(runnerFor(new Map()), "/root", plan);
  assert.isUndefined(passed.failure);
  assert.deepStrictEqual(
    passed.ran.map(({ command }) => command),
    ["vp run --filter ./apps/web typecheck", "vp test run apps/web/src/window.test.ts"],
  );

  // A failing suite is the replay's fault: the walk stops against the rows that produced it.
  const broken = runRepairs(
    runnerFor(
      new Map([["vp test run apps/web/src/window.test.ts", { status: 1, stderr: "1 failed" }]]),
    ),
    "/root",
    plan,
  );
  assert.strictEqual(broken.failure?.kind, "repair");
  assert.include(broken.failure?.detail ?? "", "1 failed");
  assert.lengthOf(broken.ran, 1);

  // A missing runner is the environment's: the lane cannot test at all.
  const missing = runRepairs(
    runnerFor(
      new Map([
        ["vp run --filter ./apps/web typecheck", { status: 127, stderr: "vp: command not found" }],
      ]),
    ),
    "/root",
    plan,
  );
  assert.strictEqual(missing.failure?.kind, "environment");
  assert.isEmpty(missing.ran);

  // A runner that throws never reaches a status, and is the same environment stop.
  const thrown = runRepairs(
    {
      run(): CommandResult {
        throw new Error("spawnSync vp ENOENT");
      },
    },
    "/root",
    plan,
  );
  assert.strictEqual(thrown.failure?.kind, "environment");
  assert.include(thrown.failure?.detail ?? "", "ENOENT");
});

it("knows which paths the lane can say anything about", () => {
  for (const path of [
    "apps/web/src/window.ts",
    "packages/contracts/src/settings.ts",
    "scripts/fork-sync.ts",
    "oxlint-plugin-t3code/src/rule.ts",
  ])
    assert.isTrue(isVerifiablePath(path), path);
  // Nothing in the verify plan reaches a root config, a workflow, a doc, or a skill, so a
  // resolution that invented text in one of those would carry no verification at all.
  for (const path of [
    "package.json",
    "tsconfig.json",
    ".github/workflows/ci.yml",
    "docs/user/threads.md",
    ".agents/skills/fork-sync/SKILL.md",
    "apps/web/package.json",
    "apps",
  ])
    assert.isFalse(isVerifiablePath(path), path);
});

it("blames the replay for a typecheck the runner did run", () => {
  const plan = [{ command: "vp", args: ["run", "--filter", "./apps/web", "typecheck"] }];
  // A moved file leaves TS2307 behind. The runner worked, so this is the replay's fault and has to
  // reach the conflict stop; reading it as a missing module and calling the lane broken would send
  // the walk to the wrong stop and lose the rows that caused it.
  const moved = runRepairs(
    runnerFor(
      new Map([
        [
          "vp run --filter ./apps/web typecheck",
          {
            status: 2,
            stdout: "src/window.ts(3,24): error TS2307: Cannot find module './moved.ts'.",
          },
        ],
      ]),
    ),
    "/root",
    plan,
  );
  assert.strictEqual(moved.failure?.kind, "repair");
  assert.include(moved.failure?.detail ?? "", "TS2307");

  // A runner that reports a spawn error instead of throwing is still the environment's stop.
  const spawned = runRepairs(
    {
      run(): CommandResult {
        return { status: 1, stdout: "", stderr: "", error: new Error("spawnSync vp ENOENT") };
      },
    },
    "/root",
    plan,
  );
  assert.strictEqual(spawned.failure?.kind, "environment");
  assert.include(spawned.failure?.detail ?? "", "ENOENT");
});

it("runs a scoped step in its own directory and records where it ran", () => {
  const seen: Array<string> = [];
  const outcome = runRepairs(
    {
      run(_command, _args, cwd): CommandResult {
        seen.push(cwd);
        return { status: 0, stdout: "", stderr: "" };
      },
    },
    "/root",
    [
      { command: "vp", args: ["run", "--filter", "./apps/web", "typecheck"] },
      { command: "vp", args: ["test", "run", "src/window.test.ts"], cwd: "apps/web" },
    ],
  );
  assert.deepStrictEqual(seen, ["/root", "/root/apps/web"]);
  assert.deepStrictEqual(
    outcome.ran.map(({ command }) => command),
    ["vp run --filter ./apps/web typecheck", "apps/web: vp test run src/window.test.ts"],
  );
  // The scoped label still reads as a test run, so the repair it owns is attributed the same way.
  assert.strictEqual(repairKind("apps/web: vp test run src/window.test.ts"), "tests");
});

it("names the command that dirtied the worktree and writes it up as one attributable commit", () => {
  const plan = [
    { command: "vp", args: ["fmt", "apps/web/src/window.ts"] },
    { command: "vp", args: ["run", "--filter", "./apps/web", "typecheck"] },
  ];
  let steps = 0;
  const outcome = runRepairs(runnerFor(new Map()), "/root", plan, undefined, () => {
    steps += 1;
    return steps > 1;
  });
  // The tree was clean after the formatter and dirty after the typecheck, so the typecheck owns
  // the commit; the first command to leave dirt is the one named, not the last that ran.
  assert.strictEqual(outcome.dirtiedBy, "vp run --filter ./apps/web typecheck");
  assert.strictEqual(outcome.failure, undefined);
  assert.strictEqual(repairKind(outcome.dirtiedBy ?? ""), "typecheck");
  assert.strictEqual(repairKind("vp fmt apps/web/src/window.ts"), "fmt");
  assert.strictEqual(repairKind("vp test run apps/web/src/window.test.ts"), "tests");

  // A pass that leaves the tree clean names nothing, so the walk has nothing to commit.
  assert.strictEqual(
    runRepairs(runnerFor(new Map()), "/root", plan, undefined, () => false).dirtiedBy,
    undefined,
  );

  assert.strictEqual(
    repairCommitMessage({
      kind: "fmt",
      tag: "v1.2.3",
      domain: "project-windows",
      command: "vp fmt apps/web/src/window.ts",
    }),
    [
      "chore(fork-sync): repair fmt after v1.2.3",
      "",
      "`vp fmt apps/web/src/window.ts` rewrote the worktree while replaying onto v1.2.3.",
      "",
      "Fork-Domain: project-windows",
      "Fork-Tier: bugfix",
      "Fork-Upstreamable: no",
      "Fork-Repair: v1.2.3",
      "",
    ].join("\n"),
  );
});

it("carries the raise trailer when the walk reconciles a ceiling its replay widened", () => {
  // Nothing rewrote the worktree here: the replay's own resolutions grew a domain past a ceiling
  // measured before them, so the message says that instead, and the trailer is what
  // `fork:delta --check` reads to accept the raise (RSI-Software/t3code-hyprws#745).
  assert.deepStrictEqual(
    repairCommitMessage({
      kind: "budget",
      tag: "v1.2.3",
      domain: "fork-meta",
      command: "vp run --no-cache fork:delta --inventory",
      budgetRaise: "the v1.2.3 replay widened custom-agents added 100 -> 130",
    }),
    [
      "chore(fork-sync): repair budget after v1.2.3",
      "",
      "Replaying onto v1.2.3 widened the stack past its own ceilings; `vp run --no-cache fork:delta --inventory` measured the new numbers.",
      "",
      "Fork-Domain: fork-meta",
      "Fork-Tier: bugfix",
      "Fork-Upstreamable: no",
      "Fork-Repair: v1.2.3",
      "Fork-Budget: raise the v1.2.3 replay widened custom-agents added 100 -> 130",
      "",
    ].join("\n"),
  );
});
