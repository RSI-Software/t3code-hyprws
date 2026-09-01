#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This host-only probe makes two synchronous hyprctl queries around an optional delay.

import * as NodeTimersPromises from "node:timers/promises";

import { UsageError as WorkspaceReporterUsageError } from "./lib/fork-cli.ts";
import { readHyprctlWorkspace, type WorkspaceRef } from "./lib/hyprland-workspace.ts";

export { UsageError as WorkspaceReporterUsageError } from "./lib/fork-cli.ts";

export { parseHyprlandWorkspaceResponse, readHyprctlWorkspace } from "./lib/hyprland-workspace.ts";
export type { WorkspaceRef } from "./lib/hyprland-workspace.ts";

const HELP = `Report the focused Hyprland workspace and the command's originating app workspace.

Usage: vp run hypr:workspace [-t <seconds>]

Options:
  -t <seconds>  Wait before reading the focused workspace (default: 0).
  -h, --help    Show this help.

Output: one stdout line: focused=<workspace> app=<workspace>.
Writes: none.
Exits: 0 on success, 1 on Hyprland/runtime failure, 2 on invalid usage.
`;

export type WorkspaceReporterArguments =
  | { readonly kind: "help" }
  | { readonly kind: "report"; readonly delaySeconds: number };

export type WorkspaceReporterDependencies = {
  readonly readActiveWindowWorkspace: () => WorkspaceRef;
  readonly readActiveWorkspace: () => WorkspaceRef;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
};

export function parseWorkspaceReporterArguments(
  argv: readonly string[],
): WorkspaceReporterArguments {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };

  let delaySeconds = 0;
  let sawDelay = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "-t") {
      throw new WorkspaceReporterUsageError(`unknown argument: ${argument ?? ""}`);
    }
    if (sawDelay) throw new WorkspaceReporterUsageError("-t may be specified only once");
    const value = argv[index + 1];
    if (value === undefined)
      throw new WorkspaceReporterUsageError("-t requires a value in seconds");
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new WorkspaceReporterUsageError(`-t must be a non-negative number; received: ${value}`);
    }
    delaySeconds = parsed;
    sawDelay = true;
    index += 1;
  }
  return { kind: "report", delaySeconds };
}

export function formatWorkspace(workspace: WorkspaceRef): string {
  return workspace.name.length > 0 ? workspace.name : String(workspace.id);
}

const defaultDependencies: WorkspaceReporterDependencies = {
  readActiveWindowWorkspace: () => readHyprctlWorkspace("activewindow"),
  readActiveWorkspace: () => readHyprctlWorkspace("activeworkspace"),
  sleep: async (milliseconds) => void (await NodeTimersPromises.setTimeout(milliseconds)),
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

export async function runWorkspaceReporter(
  argv: readonly string[],
  dependencies: WorkspaceReporterDependencies = defaultDependencies,
): Promise<number> {
  let arguments_: WorkspaceReporterArguments;
  try {
    arguments_ = parseWorkspaceReporterArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`error: ${message}\nUsage: vp run hypr:workspace [-t <seconds>]\n`);
    return 2;
  }

  if (arguments_.kind === "help") {
    dependencies.writeStdout(HELP);
    return 0;
  }

  try {
    // Capture the invoking app before the delay gives the user time to switch workspaces.
    const appWorkspace = dependencies.readActiveWindowWorkspace();
    if (arguments_.delaySeconds > 0) {
      await dependencies.sleep(arguments_.delaySeconds * 1_000);
    }
    const focusedWorkspace = dependencies.readActiveWorkspace();
    dependencies.writeStdout(
      `focused=${formatWorkspace(focusedWorkspace)} app=${formatWorkspace(appWorkspace)}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`error: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runWorkspaceReporter(process.argv.slice(2));
}
