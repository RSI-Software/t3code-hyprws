// @effect-diagnostics nodeBuiltinImport:off - Git pushes run before an Effect runtime exists.

import * as NodeChildProcess from "node:child_process";

import type { GitCommandResult } from "./fork-rebase-feasibility.ts";

const PUSH_TOKEN = process.env.HYPRWS_PUSH_TOKEN;
delete process.env.HYPRWS_PUSH_TOKEN;

const runGit = (cwd: string, args: ReadonlyArray<string>): GitCommandResult => {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
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

export const pushResult = (root: string, args: ReadonlyArray<string>): GitCommandResult => {
  const authentication =
    PUSH_TOKEN === undefined || PUSH_TOKEN.length === 0
      ? []
      : [
          "-c",
          `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${PUSH_TOKEN}`).toString("base64")}`,
        ];
  return runGit(root, [...authentication, "push", ...args]);
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
