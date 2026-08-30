// @effect-diagnostics nodeBuiltinImport:off - Git pushes run before an Effect runtime exists.

import * as NodeChildProcess from "node:child_process";

import type { GitCommandResult } from "./fork-rebase-feasibility.ts";

const PUSH_TOKEN = process.env.HYPRWS_PUSH_TOKEN;
delete process.env.HYPRWS_PUSH_TOKEN;

const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): GitCommandResult => {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

const requireSuccess = (operation: string, result: GitCommandResult): string => {
  if (result.status === 0 && result.error === undefined) return result.stdout;
  const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
  throw new Error(`${operation} failed${detail.length === 0 ? "" : `: ${detail}`}`);
};

export const remoteBranchSha = (root: string, branch: string): string | null => {
  const output = requireSuccess(
    `read origin/${branch}`,
    runGit(root, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]),
  ).trim();
  return output.length === 0 ? null : (output.split(/\s+/)[0] ?? null);
};

export const remoteBranchExists = (root: string, branch: string): boolean =>
  remoteBranchSha(root, branch) !== null;

export interface PushInvocation {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

export const buildPushInvocation = (
  args: ReadonlyArray<string>,
  token: string | undefined,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): PushInvocation => {
  const env = { ...inheritedEnv };
  if (token !== undefined && token.length > 0) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return { args: ["push", ...args], env };
};

export const pushResult = (root: string, args: ReadonlyArray<string>): GitCommandResult => {
  const invocation = buildPushInvocation(args, PUSH_TOKEN);
  return runGit(root, invocation.args, invocation.env);
};

export const restoreRemoteBranch = (
  root: string,
  branch: string,
  previousSha: string | null,
): void => {
  const ref = `refs/heads/${branch}`;
  requireSuccess(
    `restore origin/${branch}`,
    pushResult(
      root,
      previousSha === null ? ["origin", `:${ref}`] : ["--force", "origin", `${previousSha}:${ref}`],
    ),
  );
};
