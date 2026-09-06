import { assert, it } from "@effect/vitest";

import type { CommandResult, CwdCommandRunner } from "./lib/fork-command.ts";
import {
  retainRewriteArchive,
  rewriteArchiveBinding,
  rewriteArchiveRef,
} from "./lib/fork-rewrite-archive.ts";

const OLD = "a".repeat(40);
const OTHER = "b".repeat(40);
const REF = `refs/heads/archive/hyprws-pre-rewrite-${OLD.slice(0, 12)}`;
const READ = ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", REF] as const;

class FakeRunner implements CwdCommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  readonly sequences = new Map<string, Array<CommandResult>>();

  setSequence(args: ReadonlyArray<string>, responses: ReadonlyArray<Partial<CommandResult>>): void {
    this.sequences.set(
      args.join("\0"),
      responses.map((response) => ({ status: 0, stdout: "", stderr: "", ...response })),
    );
  }

  run(command: string, args: ReadonlyArray<string>): CommandResult {
    this.calls.push({ command, args });
    return this.sequences.get(args.join("\0"))?.shift() ?? { status: 0, stdout: "", stderr: "" };
  }
}

it("creates the deterministic archive with a missing-ref lease and verifies its SHA", () => {
  const runner = new FakeRunner();
  runner.setSequence(READ, [{ stdout: "" }, { stdout: `${OLD}\t${REF}\n` }]);

  assert.deepStrictEqual(retainRewriteArchive(runner, "/worktree", rewriteArchiveBinding(OLD)), {
    observedSha: OLD,
    trunkOutcome: "pending",
  });
  assert.strictEqual(rewriteArchiveRef(OLD), REF);
  assert.deepStrictEqual(runner.calls[1], {
    command: "git",
    args: [
      "-c",
      "core.commentChar=auto",
      "push",
      `--force-with-lease=${REF}:`,
      "origin",
      `${OLD}:${REF}`,
    ],
  });
});

it("accepts an exact archive on retry without pushing it again", () => {
  const runner = new FakeRunner();
  runner.setSequence(READ, [{ stdout: `${OLD}\t${REF}\n` }, { stdout: `${OLD}\t${REF}\n` }]);

  assert.deepStrictEqual(retainRewriteArchive(runner, "/worktree", rewriteArchiveBinding(OLD)), {
    observedSha: OLD,
    trunkOutcome: "pending",
  });
  assert.isFalse(runner.calls.some(({ args }) => args.includes("push")));
});

it("refuses a same-name archive at any different SHA", () => {
  const runner = new FakeRunner();
  runner.setSequence(READ, [{ stdout: `${OTHER}\t${REF}\n` }]);

  assert.throws(
    () => retainRewriteArchive(runner, "/worktree", rewriteArchiveBinding(OLD)),
    new RegExp(`rewrite archive collision: ${REF} is ${OTHER}, expected ${OLD}`),
  );
  assert.isFalse(runner.calls.some(({ args }) => args.includes("push")));
});

it("refuses when post-create readback does not resolve the expected SHA", () => {
  const runner = new FakeRunner();
  runner.setSequence(READ, [{ stdout: "" }, { stdout: `${OTHER}\t${REF}\n` }]);

  assert.throws(
    () => retainRewriteArchive(runner, "/worktree", rewriteArchiveBinding(OLD)),
    new RegExp(`rewrite archive readback failed: ${REF} is ${OTHER}, expected ${OLD}`),
  );
});
