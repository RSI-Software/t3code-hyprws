// @effect-diagnostics nodeBuiltinImport:off - The fixtures build real git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { classifyTrunkMovement, proveSegment, replaySegment } from "./fork-sync-fold.ts";

const git = (root: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): string =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();

const commit = (root: string, message: string): string => {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
};

const writeFile = (root: string, name: string, content: string): void => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, name), content);
};

/**
 * A lane worktree holding a fork stack replayed onto `base`, plus a separate trunk clone with
 * landings after `base`. Returns the trunk root, the shared base, the incorporated frontier and
 * the candidate head; the trunk root's `main` starts at `frontier` so tests advance it further.
 */
const fixture = (
  options: {
    readonly seam?: boolean;
    readonly landings?: number;
  } = {},
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-fold-test-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  writeFile(root, "seam.txt", "base\n");
  const base = commit(root, "base");
  // The candidate: a fork stack replayed onto base, on a detached lane worktree. With `seam`, it
  // also rewrites seam.txt so the upstream landing that rewrites the same file conflicts.
  const candidate = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-fold-lane-"));
  git(root, ["worktree", "add", "--detach", candidate, base]);
  git(candidate, ["config", "user.name", "test"]);
  git(candidate, ["config", "user.email", "test@example.com"]);
  writeFile(candidate, "fork.txt", "fork\n");
  if (options.seam === true) writeFile(candidate, "seam.txt", "fork\n");
  const candidateHead = commit(candidate, "feat: fork\n\nFork-Domain: fork-meta\nFork-Tier: qol");
  // Landings on trunk after base.
  const landings = options.landings ?? 1;
  git(root, ["reset", "--hard", base]);
  for (let index = 0; index < landings; index += 1) {
    writeFile(
      root,
      options.seam === true && index === landings - 1 ? "seam.txt" : `landing-${index}.txt`,
      options.seam === true && index === landings - 1 ? "upstream\n" : `${index}\n`,
    );
    commit(root, `upstream landing ${index}`);
  }
  const frontier = git(root, ["rev-parse", "main"]);
  return { root, candidate, base, frontier, candidateHead };
};

const cleanup = (item: { root: string; candidate: string }): void => {
  NodeFS.rmSync(item.candidate, { recursive: true, force: true });
  NodeFS.rmSync(item.root, { recursive: true, force: true });
};

it("classifies no movement as unchanged", () => {
  const item = fixture();
  try {
    assert.deepStrictEqual(
      classifyTrunkMovement(item.root, item.frontier, item.frontier, item.base, item.candidateHead),
      { kind: "unchanged" },
    );
  } finally {
    cleanup(item);
  }
});

it("classifies linear movement with the landed commits oldest first", () => {
  const item = fixture({ landings: 3 });
  try {
    const live = git(item.root, ["rev-parse", "main"]);
    writeFile(item.root, "landing-3.txt", "3\n");
    const after = commit(item.root, "upstream landing 3");
    const result = classifyTrunkMovement(item.root, live, after, item.base, item.candidateHead);
    assert.strictEqual(result.kind, "linear");
    if (result.kind !== "linear") return;
    assert.strictEqual(result.commits.length, 1);
    assert.strictEqual(result.commits[0], after);
  } finally {
    cleanup(item);
  }
});

it("refuses movement off the frontier, merge movement, a moved base and a moved target", () => {
  const item = fixture();
  try {
    // Non-fast-forward: live is a sibling, not a descendant of the frontier.
    git(item.root, ["checkout", "--detach", item.base]);
    writeFile(item.root, "other.txt", "other\n");
    const live = commit(item.root, "divergent landing");
    assert.strictEqual(
      classifyTrunkMovement(item.root, item.frontier, live, item.base, item.candidateHead).kind,
      "refuse",
    );
    // A merge landing: branch off the frontier, then merge it back.
    git(item.root, ["checkout", "--detach", item.frontier]);
    writeFile(item.root, "side.txt", "side\n");
    commit(item.root, "side landing");
    const side = git(item.root, ["rev-parse", "HEAD"]);
    git(item.root, ["checkout", "--detach", item.frontier]);
    git(item.root, ["merge", "--no-ff", "-m", "merge landings", side]);
    const merge = git(item.root, ["rev-parse", "HEAD"]);
    const mergeRefusal = classifyTrunkMovement(
      item.root,
      item.frontier,
      merge,
      item.base,
      item.candidateHead,
    );
    assert.strictEqual(mergeRefusal.kind, "refuse");
    if (mergeRefusal.kind === "refuse") assert.match(mergeRefusal.reason, /merge/);
    // A moved shared base: a linear live tip whose merge-base with the target is not sharedBase.
    git(item.root, ["checkout", "--detach", item.frontier]);
    writeFile(item.root, "clean.txt", "clean\n");
    const linear = commit(item.root, "clean landing");
    const baseRefusal = classifyTrunkMovement(
      item.root,
      item.frontier,
      linear,
      item.candidateHead,
      item.candidateHead,
    );
    assert.strictEqual(baseRefusal.kind, "refuse");
    if (baseRefusal.kind === "refuse") assert.match(baseRefusal.reason, /shared base/);
    // A moved target: pass a SHA that no longer resolves.
    const targetRefusal = classifyTrunkMovement(
      item.root,
      item.frontier,
      merge,
      item.base,
      "0".repeat(40),
    );
    assert.strictEqual(targetRefusal.kind, "refuse");
    if (targetRefusal.kind === "refuse") assert.match(targetRefusal.reason, /target moved/);
    void side;
    void live;
    void linear;
  } finally {
    cleanup(item);
  }
});

it("folds a clean segment onto the candidate and leaves the lane branch untouched", () => {
  const item = fixture();
  try {
    writeFile(item.root, "landing-extra.txt", "extra\n");
    const live = commit(item.root, "upstream landing");
    // Give the lane a named branch the fold must not move.
    git(item.candidate, ["branch", "lane", item.candidateHead]);
    const replay = replaySegment(
      { worktree: item.candidate },
      {
        from: item.frontier,
        to: live,
        onto: item.candidateHead,
      },
    );
    if (!("head" in replay)) throw new Error(`unexpected conflict: ${JSON.stringify(replay)}`);
    const head = git(item.candidate, ["rev-parse", "HEAD"]);
    assert.strictEqual(replay.head, head);
    assert.strictEqual(git(item.candidate, ["rev-parse", "lane"]), item.candidateHead);
    // A SHA <to> detaches HEAD: the lane branch ref stays exactly where it was.
    assert.strictEqual(git(item.candidate, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
    proveSegment(
      { worktree: item.candidate },
      {
        from: item.frontier,
        to: live,
        onto: item.candidateHead,
        head,
      },
    );
    assert.strictEqual(
      git(item.candidate, ["rev-list", "--count", `${item.candidateHead}..${head}`]),
      "1",
    );
  } finally {
    cleanup(item);
  }
});

it("reports a fold conflict with the commit and paths and leaves the rebase resumable", () => {
  const item = fixture({ seam: true });
  try {
    const replay = replaySegment(
      { worktree: item.candidate },
      {
        from: item.base,
        to: item.frontier,
        onto: item.candidateHead,
      },
    );
    if (!("conflict" in replay)) throw new Error("expected a conflict");
    assert.deepStrictEqual(replay.conflict.paths, ["seam.txt"]);
    assert.strictEqual(
      git(item.candidate, ["log", "-1", "--format=%s", replay.conflict.commit]),
      "upstream landing 0",
    );
    // The rebase is still in progress and resumable with the comment-safe config.
    NodeFS.writeFileSync(NodePath.join(item.candidate, "seam.txt"), "resolved\n");
    git(item.candidate, ["add", "seam.txt"]);
    git(item.candidate, ["-c", "core.commentChar=auto", "rebase", "--continue"], {
      GIT_EDITOR: "true",
    });
    const head = git(item.candidate, ["rev-parse", "HEAD"]);
    proveSegment(
      { worktree: item.candidate },
      {
        from: item.base,
        to: item.frontier,
        onto: item.candidateHead,
        head,
      },
    );
  } finally {
    cleanup(item);
  }
});

it("folds a second segment from the advanced frontier without duplicating earlier landings", () => {
  const item = fixture();
  try {
    writeFile(item.root, "landing-1.txt", "1\n");
    const live1 = commit(item.root, "upstream landing");
    const first = replaySegment(
      { worktree: item.candidate },
      {
        from: item.frontier,
        to: live1,
        onto: item.candidateHead,
      },
    );
    if (!("head" in first)) throw new Error("unexpected conflict on first fold");
    // Second fold: the boundary is the advanced frontier, not the original base.
    writeFile(item.root, "landing-2.txt", "2\n");
    const live2 = commit(item.root, "upstream landing 2");
    const second = replaySegment(
      { worktree: item.candidate },
      {
        from: live1,
        to: live2,
        onto: first.head,
      },
    );
    if (!("head" in second)) throw new Error("unexpected conflict on second fold");
    proveSegment(
      { worktree: item.candidate },
      { from: live1, to: live2, onto: first.head, head: second.head },
    );
    assert.strictEqual(
      git(item.candidate, ["rev-list", "--count", `${item.candidateHead}..${second.head}`]),
      "2",
    );
    assert.deepStrictEqual(
      git(item.candidate, ["log", "--format=%s", `${item.candidateHead}..${second.head}`]).split(
        "\n",
      ),
      ["upstream landing 2", "upstream landing"],
    );
  } finally {
    cleanup(item);
  }
});
