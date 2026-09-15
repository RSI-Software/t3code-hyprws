// @effect-diagnostics nodeBuiltinImport:off - These integration fixtures exercise the pre-install Node bootstrap against real Git worktrees.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  assessTrunkBase,
  captureGit,
  checkTrunkBase,
  type CaptureGit,
  type GitCapture,
  resolveMainCheckoutFromGit,
  resolveSetupProjectRoot,
  shouldReplaceEnvTarget,
} from "./setup-worktree.fork.ts";

function git(cwd: string, args: readonly string[]): string {
  return NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const fixtureContainers: string[] = [];

afterEach(() => {
  for (const container of fixtureContainers.splice(0)) {
    NodeFS.rmSync(container, { recursive: true, force: true });
  }
});

function makeContainer(): string {
  const container = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worktree-setup-"));
  fixtureContainers.push(container);
  return container;
}

function makeLinkedWorktreeFixture(): {
  readonly canonicalRoot: string;
  readonly worktree: string;
} {
  const container = makeContainer();
  const canonicalRoot = NodePath.join(container, "canonical");
  const worktree = NodePath.join(container, "linked");
  NodeFS.mkdirSync(canonicalRoot);
  git(canonicalRoot, ["init", "-b", "main"]);
  git(canonicalRoot, ["config", "user.email", "test@example.com"]);
  git(canonicalRoot, ["config", "user.name", "Test"]);
  NodeFS.writeFileSync(NodePath.join(canonicalRoot, "README.md"), "fixture\n");
  git(canonicalRoot, ["add", "README.md"]);
  git(canonicalRoot, ["commit", "-m", "fixture"]);
  git(canonicalRoot, ["worktree", "add", "-b", "linked", worktree]);
  return { canonicalRoot, worktree };
}

describe("worktree setup fork seams", () => {
  it("resolves the main checkout through a linked worktree's common directory", () => {
    const fixture = makeLinkedWorktreeFixture();
    assert.strictEqual(resolveMainCheckoutFromGit(fixture.worktree, {}), fixture.canonicalRoot);
  });

  it("refuses a separate Git common-directory layout", () => {
    const container = makeContainer();
    const worktree = NodePath.join(container, "worktree");
    git(container, ["init", "--separate-git-dir", NodePath.join(container, "meta"), worktree]);
    assert.throws(
      () => resolveMainCheckoutFromGit(worktree, {}),
      /unsupported Git common directory layout/u,
    );
  });

  it("ignores a foreign Git discovery environment", () => {
    const fixture = makeLinkedWorktreeFixture();
    const foreign = makeLinkedWorktreeFixture();
    const invocationDirectory = NodePath.join(fixture.worktree, "apps", "server");
    NodeFS.mkdirSync(invocationDirectory, { recursive: true });
    assert.strictEqual(
      resolveMainCheckoutFromGit(invocationDirectory, {
        ...process.env,
        GIT_COMMON_DIR: NodePath.join(foreign.canonicalRoot, ".git"),
        GIT_CEILING_DIRECTORIES: fixture.worktree,
        GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
      }),
      fixture.canonicalRoot,
    );
  });

  it("prefers an existing T3CODE_PROJECT_ROOT and falls back to Git when it is stale or unset", () => {
    const fixture = makeLinkedWorktreeFixture();
    const other = makeContainer();
    assert.strictEqual(
      resolveSetupProjectRoot({ T3CODE_PROJECT_ROOT: other }, fixture.worktree),
      other,
    );
    assert.strictEqual(
      resolveSetupProjectRoot(
        { T3CODE_PROJECT_ROOT: NodePath.join(other, "missing") },
        fixture.worktree,
      ),
      fixture.canonicalRoot,
    );
    assert.strictEqual(resolveSetupProjectRoot({}, fixture.worktree), fixture.canonicalRoot);
  });

  it("replaces absent targets and symlinks but preserves a regular file", () => {
    const container = makeContainer();
    const regular = NodePath.join(container, "regular.env");
    const link = NodePath.join(container, "link.env");
    NodeFS.writeFileSync(regular, "KEEP=1\n");
    NodeFS.symlinkSync(NodePath.join(container, "stale"), link);
    assert.isTrue(shouldReplaceEnvTarget(NodePath.join(container, "absent.env")));
    assert.isTrue(shouldReplaceEnvTarget(link));
    assert.isFalse(shouldReplaceEnvTarget(regular));
  });
});

describe("trunk-base check", () => {
  const headSha = "a".repeat(40);
  const publishedSha = "b".repeat(40);
  const localTrunkSha = "c".repeat(40);

  function stubCapture(responses: Record<string, Partial<GitCapture>>): CaptureGit {
    return (_cwd, args) => {
      const key = args.join(" ");
      const response =
        responses[key] ??
        responses[args.slice(0, 3).join(" ")] ??
        responses[args.slice(0, 2).join(" ")];
      if (!response) throw new Error(`unexpected git invocation: git ${key}`);
      return {
        code: response.code ?? 0,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    };
  }

  const baseResponses = {
    "fetch origin hyprws": {},
    "rev-parse --verify refs/remotes/origin/hyprws": { stdout: `${publishedSha}\n` },
    "rev-parse HEAD": { stdout: `${headSha}\n` },
    "branch -r --contains": { stdout: "  origin/hyprws\n" },
    "rev-parse --verify refs/heads/hyprws": { stdout: `${localTrunkSha}\n` },
  };

  it("accepts a HEAD contained in a remote-tracking ref", () => {
    const assessment = assessTrunkBase(stubCapture(baseResponses), "/worktree");

    assert.deepStrictEqual(assessment, {
      kind: "assessed",
      contained: true,
      headSha,
      publishedSha,
      localTrunkSha,
    });
  });

  it("accepts an upstream/main base via its own remote ref", () => {
    const assessment = assessTrunkBase(
      stubCapture({ ...baseResponses, "branch -r --contains": { stdout: "  upstream/main\n" } }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "assessed",
      contained: true,
      headSha,
      publishedSha,
      localTrunkSha,
    });
  });

  it("reports a HEAD contained in no remote ref with both shas", () => {
    const assessment = assessTrunkBase(
      stubCapture({ ...baseResponses, "branch -r --contains": { code: 0, stdout: "" } }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "assessed",
      contained: false,
      headSha,
      publishedSha,
      localTrunkSha,
    });
  });

  it("skips when the fetch fails and carries the git error", () => {
    const assessment = assessTrunkBase(
      stubCapture({
        "fetch origin hyprws": { code: 128, stderr: "fatal: no origin\n" },
      }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "skipped",
      reason: "could not fetch origin hyprws: fatal: no origin",
    });
  });

  it("skips when origin/hyprws is missing after the fetch", () => {
    const assessment = assessTrunkBase(
      stubCapture({
        "fetch origin hyprws": {},
        "rev-parse --verify refs/remotes/origin/hyprws": { code: 128 },
      }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "skipped",
      reason: "origin/hyprws not found after the fetch",
    });
  });

  it("reports no local trunk when the hyprws branch does not exist", () => {
    const assessment = assessTrunkBase(
      stubCapture({
        ...baseResponses,
        "rev-parse --verify refs/heads/hyprws": { code: 128 },
      }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "assessed",
      contained: true,
      headSha,
      publishedSha,
      localTrunkSha: undefined,
    });
  });

  it("refuses a worktree HEAD with no containing remote ref", () => {
    let stdout = "";
    assert.throws(
      () =>
        checkTrunkBase(
          "/worktree",
          "/canonical",
          stubCapture({ ...baseResponses, "branch -r --contains": { code: 0, stdout: "" } }),
          (value) => {
            stdout += value;
          },
        ),
      /contained in no remote-tracking ref.*git reset --hard origin\/hyprws.*--base origin\/hyprws/u,
    );
    assert.strictEqual(stdout, "");
  });

  it("notices a stale local trunk and continues", () => {
    let stdout = "";
    checkTrunkBase("/worktree", "/canonical", stubCapture(baseResponses), (value) => {
      stdout += value;
    });
    assert.match(
      stdout,
      /notice: local 'hyprws' \(cccccccccccc\).*git -C \/canonical reset --hard origin\/hyprws/u,
    );
  });

  it("refuses a branch cut from discarded trunk history until it is reset", () => {
    const fixture = makeTrunkFixture();
    let stdout = "";
    const write = (value: string) => {
      stdout += value;
    };
    assert.throws(
      () => checkTrunkBase(fixture.worktree, fixture.canonicalRoot, captureGit, write),
      /contained in no remote-tracking ref/u,
    );

    git(fixture.worktree, ["reset", "--hard", "origin/hyprws"]);
    NodeFS.writeFileSync(NodePath.join(fixture.worktree, "README.md"), "advanced\n");
    git(fixture.worktree, ["commit", "-am", "advanced"]);
    git(fixture.worktree, ["push", "origin", "HEAD:hyprws"]);

    checkTrunkBase(fixture.worktree, fixture.canonicalRoot, captureGit, write);
    assert.match(stdout, /notice: local 'hyprws'/u);
  });

  function makeTrunkFixture(): { readonly canonicalRoot: string; readonly worktree: string } {
    const container = makeContainer();
    const origin = NodePath.join(container, "origin.git");
    const canonicalRoot = NodePath.join(container, "canonical");
    const worktree = NodePath.join(container, "linked");
    git(container, ["init", "--bare", "-b", "hyprws", origin]);
    NodeFS.mkdirSync(canonicalRoot);
    git(canonicalRoot, ["init", "-b", "hyprws"]);
    git(canonicalRoot, ["config", "user.email", "test@example.com"]);
    git(canonicalRoot, ["config", "user.name", "Test"]);
    git(canonicalRoot, ["remote", "add", "origin", origin]);
    NodeFS.writeFileSync(NodePath.join(canonicalRoot, "README.md"), "base\n");
    git(canonicalRoot, ["add", "README.md"]);
    git(canonicalRoot, ["commit", "-m", "base"]);
    NodeFS.writeFileSync(NodePath.join(canonicalRoot, "README.md"), "discarded\n");
    git(canonicalRoot, ["commit", "-am", "discarded"]);
    git(canonicalRoot, ["push", "origin", "hyprws"]);
    git(canonicalRoot, ["worktree", "add", "-b", "linked", worktree]);
    NodeFS.mkdirSync(NodePath.join(worktree, "infra", "relay"), { recursive: true });
    git(canonicalRoot, ["reset", "--hard", "HEAD~1"]);
    NodeFS.writeFileSync(NodePath.join(canonicalRoot, "README.md"), "rewritten\n");
    git(canonicalRoot, ["commit", "-am", "rewritten"]);
    git(canonicalRoot, ["push", "--force", "origin", "hyprws"]);
    return { canonicalRoot, worktree };
  }
});
