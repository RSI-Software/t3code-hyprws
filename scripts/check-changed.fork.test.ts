// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { comparisonBase } from "./check-changed.ts";

// Hooks export GIT_DIR and GIT_INDEX_FILE; user config can sign or ignore fixture files.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

it("compares a fork branch against origin/hyprws, not upstream's main", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-fork-")),
  );
  try {
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    const commits: Record<string, string> = {};
    for (const name of ["A", "B", "C"]) {
      git("commit", "--allow-empty", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const remote of ["origin", "upstream"]) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits.A!);
    }
    git("update-ref", "refs/remotes/origin/hyprws", commits.B!);

    const compare = (ref: Option.Option<string>) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* comparisonBase(root, ref).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

    const trunk = await compare(Option.none());
    assert.strictEqual(trunk.ref, "origin/hyprws");
    assert.strictEqual(trunk.base, commits.B);
    assert.strictEqual((await compare(Option.some("upstream/main"))).base, commits.A);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
