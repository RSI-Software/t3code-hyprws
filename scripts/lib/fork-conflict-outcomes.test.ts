// @effect-diagnostics nodeBuiltinImport:off - Outcome execution writes real files in a fixture worktree.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { SystemCommandRunner, type CwdCommandRunner, type CommandResult } from "./fork-command.ts";
import {
  classifyConflictOutcome,
  everyConflictIsCoInsertion,
  executeConflictOutcome,
  isUnresolved,
  preservesUpstreamAdditions,
} from "./fork-conflict-outcomes.ts";

const stages = (
  base: string,
  ours: string,
  theirs: string,
): Parameters<typeof classifyConflictOutcome>[0] => ({ base, ours, theirs });

it("applies fork doctrine to a conflicted seam in one total function", () => {
  // Only upstream moved.
  assert.deepInclude(classifyConflictOutcome(stages("a\n", "b\n", "a\n")), {
    take: "ours",
    conflictClass: "mechanical",
    source: "upstream-only",
  });
  // Only the fork moved, so the fork feature keeps working.
  assert.deepInclude(classifyConflictOutcome(stages("a\n", "a\n", "c\n")), {
    take: "theirs",
    conflictClass: "mechanical",
    source: "fork-only",
  });
  // Two approaches to the same seam: keep both, and say the fork side is worth a second look.
  const both = classifyConflictOutcome(stages("a\n", "b\n", "c\n"));
  assert.deepInclude(both, { take: "union", conflictClass: "seam-moved", source: "keep-both" });
  assert.include(both.resolution, "consider keeping ours");
});

it("refuses a resolution that drops a line upstream added", () => {
  // The fork is additive: dropping its own line is allowed, dropping upstream's never is.
  assert.isTrue(preservesUpstreamAdditions("a\n", "a\nup\n", "a\nup\nfork\n"));
  assert.isTrue(preservesUpstreamAdditions("a\nold\n", "a\n", "a\nfork\n"));
  assert.isFalse(preservesUpstreamAdditions("a\n", "a\nup\n", "a\nfork\n"));
  // Blank lines are formatting, not content.
  assert.isTrue(preservesUpstreamAdditions("a\n", "a\n\nup\n", "a\nup\n"));
});

const fixture = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-outcome-test-"));
  NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
};

/** Stage the three rebase index stages for one path, exactly as a conflicted replay leaves them. */
const stageConflict = (
  root: string,
  path: string,
  contents: { readonly base: string; readonly ours: string; readonly theirs: string },
): void => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  const entries = ([1, 2, 3] as const)
    .map((stage) => {
      const value = stage === 1 ? contents.base : stage === 2 ? contents.ours : contents.theirs;
      const sha = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        input: value,
      })
        .toString()
        .trim();
      return `100644 ${sha} ${stage}\t${path}`;
    })
    .join("\n");
  NodeChildProcess.execFileSync("git", ["update-index", "--index-info"], {
    cwd: root,
    input: `${entries}\n`,
  });
};

it("resolves a conflicted path from its index stages and stages the result", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/window.ts";
  try {
    stageConflict(root, path, {
      base: "shared\n",
      ours: "shared\nupstream\n",
      theirs: "shared\nfork\n",
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.strictEqual(outcome.take, "union");
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    assert.include(resolved, "upstream");
    assert.include(resolved, "fork");
    assert.notInclude(resolved, "<<<<<<<");
    // Staged, so `git rebase --continue` sees a resolved path and not a dirty tree.
    assert.strictEqual(
      NodeChildProcess.execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: root,
      })
        .toString()
        .trim(),
      "",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines the shapes a maintainer owns instead of guessing", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  try {
    // Add/add: no merge base on this path.
    const added = "apps/web/src/added.ts";
    NodeFS.mkdirSync(NodePath.join(root, "apps/web/src"), { recursive: true });
    for (const [stage, value] of [
      [2, "upstream\n"],
      [3, "fork\n"],
    ] as const) {
      const sha = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        input: value,
      })
        .toString()
        .trim();
      NodeChildProcess.execFileSync("git", ["update-index", "--index-info"], {
        cwd: root,
        input: `100644 ${sha} ${stage}\t${added}\n`,
      });
    }
    const noBase = executeConflictOutcome(runner, root, added);
    assert.isTrue(isUnresolved(noBase));
    if (!isUnresolved(noBase)) return;
    assert.include(noBase.reason, "no common ancestor");

    // Binary: nothing here can read it, so nothing here may resolve it.
    const binary = "apps/web/src/icon.bin";
    stageConflict(root, binary, {
      base: "\0base",
      ours: "\0upstream",
      theirs: "\0fork",
    });
    const opaque = executeConflictOutcome(runner, root, binary);
    assert.isTrue(isUnresolved(opaque));
    if (!isUnresolved(opaque)) return;
    assert.include(opaque.reason, "binary");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines a resolution that would drop an upstream addition", () => {
  const root = fixture();
  const path = "apps/web/src/window.ts";
  // The check bites when a union merge cannot carry an upstream line through, so drive it from a
  // merge that loses one.
  const runner: CwdCommandRunner = {
    run(command, args, cwd, input, env): CommandResult {
      if (command === "git" && args[0] === "merge-file")
        return { status: 0, stdout: "shared\nfork\n", stderr: "" };
      return new SystemCommandRunner().run(command, args, cwd, input, env);
    },
  };
  try {
    stageConflict(root, path, {
      base: "shared\n",
      ours: "shared\nupstream\n",
      theirs: "shared\nfork\n",
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isTrue(isUnresolved(outcome));
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, "upstream added");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines a seam both sides rewrote, and keeps a pure co-insertion", () => {
  assert.isTrue(
    everyConflictIsCoInsertion(
      ["<<<<<<< upstream", "up", "||||||| base", "=======", "fork", ">>>>>>> fork"].join("\n"),
    ),
  );
  assert.isFalse(
    everyConflictIsCoInsertion(
      ["<<<<<<< upstream", "up", "||||||| base", "old", "=======", "fork", ">>>>>>> fork"].join(
        "\n",
      ),
    ),
  );

  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/window.ts";
  try {
    // Both sides rewrote the same call. A union would emit both statements, which is a file that
    // says two things at once, so the executor declines instead of writing it.
    stageConflict(root, path, {
      base: "emit(a, {});\n",
      ours: "emit(a, { retries: 2 });\n",
      theirs: "emit(a, { hyprws: true });\n",
    });
    const rewritten = executeConflictOutcome(runner, root, path);
    assert.isTrue(isUnresolved(rewritten));
    if (!isUnresolved(rewritten)) return;
    assert.include(rewritten.reason, "rewrote the same lines");
    // A decline writes nothing, so the conflicted path is left for the maintainer as it was.
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, path)));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines a kept-both resolution on a path the lane cannot verify", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  try {
    for (const path of [".github/workflows/ci.yml", "package.json", "docs/user/threads.md"]) {
      stageConflict(root, path, { base: "a\n", ours: "a\nup\n", theirs: "a\nfork\n" });
      const outcome = executeConflictOutcome(runner, root, path);
      assert.isTrue(isUnresolved(outcome), path);
      if (!isUnresolved(outcome)) return;
      assert.include(outcome.reason, "cannot typecheck or test");
    }
    // The same shape inside a workspace resolves, because the lane checks it afterwards.
    const checked = "apps/web/src/window.ts";
    stageConflict(root, checked, { base: "a\n", ours: "a\nup\n", theirs: "a\nfork\n" });
    assert.isFalse(isUnresolved(executeConflictOutcome(runner, root, checked)));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("never resolves a kept commit's file to the upstream side alone", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/window.ts";
  const body = ["", "const pad = 1;", "const pad2 = 2;", "const pad3 = 3;", ""].join("\n");
  try {
    // Upstream carries a same-named export, which is what retire evidence greps for. The commit is
    // kept, so its own hunk has to survive: taking `ours` here would keep the commit and gut it.
    stageConflict(root, path, {
      base: `export const openWindow = () => null;\n${body}`,
      ours: `export const openWindow = () => upstream();\n${body}`,
      theirs: `export const openWindow = () => null;\n${body}export const forkOnly = () => hyprws();\n`,
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.notStrictEqual(outcome.take, "ours");
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    assert.include(resolved, "forkOnly");
    assert.include(resolved, "upstream()");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
