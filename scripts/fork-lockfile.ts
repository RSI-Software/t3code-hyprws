#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone lockfile guard runs before an Effect runtime exists.

// Proves the checked-in `pnpm-lock.yaml` is exactly what its generator produces.
//
// docs/operations/fork-sync.md registers `pnpm-lock.yaml` as the fork's only
// regenerable path, with `vp install --lockfile-only` as its generator. A rebase
// stop on it is only cheap while that holds: the documented resolution restores
// the lockfile from `HEAD`, resolves the source conflicts, and reruns the
// generator. A lockfile that was hand-merged, or carried forward as a replayed
// historical patch, silently stops matching its manifests, and the next rebase
// discovers that at a stop instead of here.
//
// fork-sync already runs this comparison during replay verification, where a
// failure costs a whole lane. This is the same proof at authoring time, on the
// branch that introduced the dependency change, which is where it is cheap.
//
// The check is non-destructive: the generator writes in place, so the original
// bytes are always written back before returning, on every exit path including a
// throw or an interrupt.
//
// Scope, and its limit. Only importer drift fails the check. `vp install
// --lockfile-only` performs a full resolution, so it re-picks every open range in
// the tree, not just the ranges this branch touched: regenerating on a months-old
// lockfile moves transitive pins that no manifest here asked for. That churn lands
// in the `snapshots:` section, so snapshot differences are reported as a note and
// never fail. The `importers:` section is manifest-driven -- it records the
// specifier each workspace declared -- so drift there does mean a manifest change
// never reached the lockfile, which is the failure worth refusing. Keep this off
// the required-check list for the same reason: a green run depends on when the
// registry last moved.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { lockDriftClass } from "./fork-sync.ts";
import { parseArgs as parseCliArgs, UsageError } from "./lib/fork-cli.ts";
import { runCommand } from "./lib/fork-command.ts";

export const LOCKFILE_PATH = "pnpm-lock.yaml";

/** The generator docs/operations/fork-sync.md registers for the lockfile. */
export const LOCKFILE_GENERATOR = { command: "vp", args: ["install", "--lockfile-only"] } as const;

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LockfileEnv {
  readonly git: (args: ReadonlyArray<string>) => CommandResult;
  readonly generate: () => CommandResult;
  readonly readLockfile: () => string;
  readonly writeLockfile: (content: string) => void;
  /**
   * Registers `restore` against an interrupt and returns the disposer that
   * unregisters it. `finally` covers a throw; a signal ends the process without
   * unwinding, so only this covers Ctrl-C over a half-written lockfile.
   */
  readonly onInterrupt?: (restore: () => void) => () => void;
}

export type LockfileStatus =
  | "ok"
  | "resolutions-differ"
  | "uncommitted"
  | "generator-failed"
  | "drift";

export interface LockfileReport {
  readonly status: LockfileStatus;
  readonly detail: string;
  /** Set only when the check failed; `renderReport` keys the verdict off it. */
  readonly remedy: string | null;
  /** Advisory prose for a pass that is not a clean match. */
  readonly note: string | null;
  /** The drift class fork-sync reports for the same comparison. */
  readonly drift: ReturnType<typeof lockDriftClass>;
}

const firstLine = (value: string): string => value.trim().split("\n")[0]?.trim() ?? "";

const IMPORTER_REMEDY =
  `run \`${LOCKFILE_GENERATOR.command} ${LOCKFILE_GENERATOR.args.join(" ")}\` and commit ${LOCKFILE_PATH} with the ` +
  "manifest change; importer drift means a declared specifier never reached the lockfile, and the rebase refuses " +
  "to carry the lockfile separately from the fork commit that owns the manifest";

const SNAPSHOT_NOTE =
  "the generator re-resolves every open range, so unrelated transitive pins move on their own schedule; commit " +
  "those lines only when this change is what moved them";

/**
 * Regenerates the lockfile in place, compares, and restores the original bytes.
 * The working tree is left exactly as it was found in every outcome.
 */
export const checkLockfile = (env: LockfileEnv): LockfileReport => {
  const status = env.git(["status", "--porcelain", "--", LOCKFILE_PATH]);
  if (status.status !== 0) {
    return {
      status: "uncommitted",
      detail: `git status failed: ${firstLine(status.stderr) || `exit ${status.status}`}`,
      remedy: "run the check inside the fork checkout",
      note: null,
      drift: "none",
    };
  }
  if (status.stdout.trim().length > 0) {
    return {
      status: "uncommitted",
      // A dirty lockfile has no committed bytes to compare against, and the
      // regeneration below would overwrite the uncommitted ones.
      detail: `${LOCKFILE_PATH} has uncommitted changes`,
      remedy: `commit or restore ${LOCKFILE_PATH}, then rerun the check`,
      note: null,
      drift: "none",
    };
  }

  const before = env.readLockfile();
  const restore = () => {
    if (env.readLockfile() !== before) env.writeLockfile(before);
  };
  const disposeInterruptGuard = env.onInterrupt?.(restore) ?? (() => {});
  try {
    const generated = env.generate();
    if (generated.status !== 0) {
      return {
        status: "generator-failed",
        detail: `${LOCKFILE_GENERATOR.command} ${LOCKFILE_GENERATOR.args.join(" ")} failed: ${
          firstLine(generated.stderr) || firstLine(generated.stdout) || `exit ${generated.status}`
        }`,
        remedy: "fix the manifests the generator rejected, then rerun the check",
        note: null,
        drift: "none",
      };
    }

    const drift = lockDriftClass(before, env.readLockfile());
    if (drift === "importers") {
      return {
        status: "drift",
        detail: `${LOCKFILE_PATH} does not record the specifiers its manifests declare`,
        remedy: IMPORTER_REMEDY,
        note: null,
        drift,
      };
    }
    if (drift === "snapshots") {
      return {
        status: "resolutions-differ",
        detail: `${LOCKFILE_PATH} matches its manifests; a fresh resolution picks different transitive versions`,
        remedy: null,
        note: SNAPSHOT_NOTE,
        drift,
      };
    }
    return {
      status: "ok",
      detail: `${LOCKFILE_PATH} regenerates unchanged`,
      remedy: null,
      note: null,
      drift,
    };
  } finally {
    restore();
    disposeInterruptGuard();
  }
};

export const renderReport = (report: LockfileReport): string => {
  if (report.remedy !== null) return `failed: ${report.detail}\n  ${report.remedy}\n`;
  return report.note === null
    ? `ok: ${report.detail}\n`
    : `ok: ${report.detail}\n  ${report.note}\n`;
};

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export const systemEnv = (root: string): LockfileEnv => {
  const lockfile = NodePath.join(root, LOCKFILE_PATH);
  return {
    git: (args) => runCommand("git", args, { cwd: root }),
    generate: () => runCommand(LOCKFILE_GENERATOR.command, LOCKFILE_GENERATOR.args, { cwd: root }),
    readLockfile: () => NodeFS.readFileSync(lockfile, "utf8"),
    writeLockfile: (content) => NodeFS.writeFileSync(lockfile, content),
    onInterrupt: (restore) => {
      const registered = INTERRUPT_SIGNALS.map((signal) => {
        const handler = () => {
          restore();
          // Unregister first, then re-raise, so the signal gets its default
          // disposition and the exit code stays the one the caller expects.
          process.removeListener(signal, handler);
          process.kill(process.pid, signal);
        };
        process.on(signal, handler);
        return { signal, handler };
      });
      return () => {
        for (const { signal, handler } of registered) process.removeListener(signal, handler);
      };
    },
  };
};

export const repositoryRoot = (cwd: string): string => {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  const root = result.stdout.trim();
  if (result.status !== 0 || root.length === 0) {
    throw new Error(`not inside a Git repository: ${cwd}`);
  }
  return root;
};

export interface LockfileOutput {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const processOutput: LockfileOutput = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

const HELP = `Usage: vp run fork:lockfile [--check]

Regenerate ${LOCKFILE_PATH} with \`${LOCKFILE_GENERATOR.command} ${LOCKFILE_GENERATOR.args.join(" ")}\`
and refuse a committed lockfile whose importers do not match its manifests. The
working tree is restored either way.

Only importer drift fails. The generator re-resolves every open range, so
transitive versions move for reasons a branch does not own; that difference is
reported as a note. Do not make this a required check.

Options:
  --check     Report and exit non-zero on drift (the default and only mode)
  -h, --help  Show help

Exit codes:
  0  the committed lockfile records the specifiers its manifests declare
  1  importer drift, an uncommitted lockfile, or a failing generator
  2  usage error
`;

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  output: LockfileOutput = processOutput,
): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    output.stdout(HELP);
    return 0;
  }
  try {
    const unknown = argv.find((argument) => argument !== "--check");
    if (unknown !== undefined) throw new UsageError(`unknown option: ${unknown}`);
    parseCliArgs(argv, { flags: ["--check"], duplicateFlags: true });
    const report = checkLockfile(systemEnv(repositoryRoot(cwd)));
    if (report.remedy === null) {
      output.stdout(renderReport(report));
      return 0;
    }
    output.stderr(renderReport(report));
    return 1;
  } catch (error) {
    if (error instanceof UsageError) {
      output.stderr(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    output.stderr(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
