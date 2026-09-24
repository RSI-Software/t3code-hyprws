// @effect-diagnostics nodeBuiltinImport:off - The stale-delete check is Git plumbing; fixtures need real repositories.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { systemForkCiGit } from "./fork-ci-flags.ts";
import { SystemGit } from "./fork-command.ts";
import { staleDeletes } from "./fork-stale-delete.ts";

const DUPLICATE = "return upstreamValue;\n";
const UPSTREAM = `const upstreamIconOnly = true;\n}\n${DUPLICATE}${DUPLICATE}`;
const ONE_COPY = UPSTREAM.replace(DUPLICATE, "");

it("flags a PR commit deleting an upstream line a later commit restores, and nothing else", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-stale-delete-"));
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  const commit = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) NodeFS.writeFileSync(`${root}/${file}`, text);
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--quiet", "--initial-branch", "main");
    git("update-ref", "refs/remotes/upstream/main", commit({ "view.ts": UPSTREAM }));
    // Below the PR base: the same delete-then-restore pair is out of scope.
    commit({ "view.ts": ONE_COPY });
    const base = commit({ "view.ts": UPSTREAM, "fork.ts": "const forkOwnedLine = 1;\n" });
    // Deletes `}`, a fork-owned line, a duplicated line nothing re-adds, and the one hit.
    const deleting = commit({ "view.ts": DUPLICATE, "fork.ts": "\n" });
    commit({ "view.ts": ONE_COPY, "fork.ts": "const forkOwnedLine = 1;\n" });
    const hit = `${deleting.slice(0, 10)} view.ts: const upstreamIconOnly = true;`;
    assert.deepStrictEqual(staleDeletes(systemForkCiGit(new SystemGit(root)), base, "HEAD"), [hit]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
