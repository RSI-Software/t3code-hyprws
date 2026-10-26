// @effect-diagnostics nodeBuiltinImport:off - These fixtures drive the install script against real Git config.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import { pinGhDefault } from "./fork-gh-default.ts";

const containers: string[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    NodeFS.rmSync(container, { recursive: true, force: true });
  }
});

function repository(remotes: Readonly<Record<string, string>>): {
  readonly cwd: string;
  readonly config: (key: string) => string | undefined;
} {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gh-default-"));
  containers.push(cwd);
  const git = (args: readonly string[]) =>
    NodeChildProcess.spawnSync("git", [...args], { cwd, encoding: "utf8" });
  git(["init", "-q"]);
  for (const [name, url] of Object.entries(remotes)) git(["remote", "add", name, url]);
  return {
    cwd,
    config: (key) => {
      const result = git(["config", "--get", key]);
      return result.status === 0 ? result.stdout.trim() : undefined;
    },
  };
}

describe("pinGhDefault", () => {
  it("moves gh's default from upstream to the fork remote, once", () => {
    const repo = repository({
      origin: "git@github.com:RSI-Software/t3code-hyprws.git",
      upstream: "git@github.com:pingdotgg/t3code.git",
    });
    NodeChildProcess.execFileSync("git", ["config", "remote.upstream.gh-resolved", "base"], {
      cwd: repo.cwd,
    });

    assert.strictEqual(pinGhDefault(repo.cwd), "origin");
    assert.strictEqual(repo.config("remote.origin.gh-resolved"), "base");
    assert.strictEqual(repo.config("remote.upstream.gh-resolved"), undefined);
    assert.strictEqual(pinGhDefault(repo.cwd), undefined);
  });

  it("leaves a clone without a fork remote, or no repository, untouched", () => {
    const repo = repository({ origin: "https://github.com/pingdotgg/t3code.git" });
    assert.strictEqual(pinGhDefault(repo.cwd), undefined);
    assert.strictEqual(repo.config("remote.origin.gh-resolved"), undefined);

    const plain = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gh-default-"));
    containers.push(plain);
    assert.strictEqual(pinGhDefault(plain), undefined);
  });
});
