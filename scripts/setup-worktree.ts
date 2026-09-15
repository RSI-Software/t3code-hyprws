// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell T3 Code spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, then warms the web dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as SetupWorktreeFork from "./setup-worktree.fork.ts"; // fork-hook: upstream-fixes/setup-worktree-import

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = SetupWorktreeFork.resolveSetupProjectRoot(process.env, import.meta.dirname); // fork-hook: upstream-fixes/setup-worktree-project-root
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
const worktree = NodePath.dirname(import.meta.dirname);
SetupWorktreeFork.checkTrunkBase(worktree, projectRoot); // fork-hook: upstream-fixes/setup-worktree-trunk-base

// `shell` resolves `vp` through PATH, including Windows command shims.
const install = NodeChildProcess.spawnSync("vp i", {
  cwd: worktree,
  shell: true,
  stdio: "inherit",
});
if (install.status !== 0) process.exit(install.status ?? 1);

// In the main checkout itself, relinking would replace the real env files.
if (NodeFS.realpathSync(projectRoot) !== NodeFS.realpathSync(worktree)) {
  for (const file of ENV_FILES) {
    const source = NodePath.join(projectRoot, file);
    if (!NodeFS.existsSync(source)) continue;
    const target = NodePath.join(worktree, file);
    if (!SetupWorktreeFork.shouldReplaceEnvTarget(target)) continue; // fork-hook: upstream-fixes/setup-worktree-keep-regular-file
    NodeFS.rmSync(target, { force: true });
    NodeFS.symlinkSync(source, target);
  }
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
