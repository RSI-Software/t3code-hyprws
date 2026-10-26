// @effect-diagnostics nodeBuiltinImport:off - an install lifecycle script; Node built-ins only, so it never fails an install.
/**
 * Pins `gh` in this clone to the fork on every install: with an `upstream` remote too, `gh` refuses
 * or picks `pingdotgg/t3code` until `gh repo set-default` runs. Writing the same
 * `remote.<name>.gh-resolved` mark directly leaves machines without `gh` unchanged. Linked
 * worktrees share the clone's config.
 */
import * as NodeChildProcess from "node:child_process";

const FORK_REPOSITORY = /[:/]RSI-Software\/t3code-hyprws(?:\.git)?\/?$/iu;

function git(cwd: string, args: readonly string[]): string | undefined {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : undefined;
}

function remoteValues(cwd: string, key: string): ReadonlyArray<readonly [string, string]> {
  const pattern = new RegExp(`^remote\\.(.+)\\.${key}\\s+(\\S+)$`, "u");
  return (git(cwd, ["config", "--get-regexp", `^remote\\..*\\.${key}$`]) ?? "")
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = pattern.exec(line.trim());
      return match ? [[match[1]!, match[2]!] as const] : [];
    });
}

/** Marks the fork remote as `gh`'s default, clearing marks on other remotes; returns it when changed. */
export function pinGhDefault(cwd: string): string | undefined {
  const fork = remoteValues(cwd, "url").find(([, url]) => FORK_REPOSITORY.test(url))?.[0];
  if (fork === undefined) return undefined;
  const marks = remoteValues(cwd, "gh-resolved");
  if (marks.length === 1 && marks[0]![0] === fork && marks[0]![1] === "base") return undefined;
  // gh reads the first marked remote in upstream, github, origin order, so a stale mark elsewhere wins.
  for (const [remote] of marks) {
    if (remote !== fork) git(cwd, ["config", "--unset-all", `remote.${remote}.gh-resolved`]);
  }
  return git(cwd, ["config", `remote.${fork}.gh-resolved`, "base"]) === undefined
    ? undefined
    : fork;
}

if (import.meta.main) {
  const remote = pinGhDefault(process.cwd());
  if (remote !== undefined) {
    process.stdout.write(`[fork-gh-default] gh now targets remote '${remote}'\n`);
  }
}
