import {
  VcsProcessExitError,
  type VcsFreshness,
  type VcsError,
  type VcsListWorkspaceFilesResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { splitNullSeparatedGitStdoutPaths } from "./GitVcsDriverCore.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

// Mirrors the upstream module-local constants so the fork listing matches the
// shared `git ls-files` hardening and output budget exactly.
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const runGitLsFiles = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
) =>
  process.run({
    operation,
    command: "git",
    args: ["-C", cwd, ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "ls-files", ...args, "-z"],
    cwd,
    spawnCwd: globalThis.process.cwd(),
    allowNonZeroExit: true,
    timeoutMs: 20_000,
    maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
    appendTruncationMarker: true,
  });

/**
 * Fork-owned `listIgnoredWorkspaceFiles` driver member: the ignored-path
 * counterpart of the upstream `listWorkspaceFiles` `git ls-files` call, kept
 * out of the shared driver body so the upstream function stays verbatim.
 */
export const makeListIgnoredWorkspaceFiles =
  (deps: {
    readonly vcsProcess: VcsProcess.VcsProcess["Service"];
    readonly nowFreshness: () => Effect.Effect<VcsFreshness>;
  }) =>
  (cwd: string): Effect.Effect<VcsListWorkspaceFilesResult, VcsError> =>
    runGitLsFiles(deps.vcsProcess, "GitVcsDriver.listIgnoredWorkspaceFiles", cwd, [
      "--others",
      "--ignored",
      "--exclude-standard",
    ]).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* deps.nowFreshness();
              return {
                paths: splitNullSeparatedGitStdoutPaths(result),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listIgnoredWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );
