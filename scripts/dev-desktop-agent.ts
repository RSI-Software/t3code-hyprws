#!/usr/bin/env node

/** Start, restart, or inspect this worktree's agent-placed desktop dev app. */

const HELP = `Start or inspect the worktree's agent-placed desktop development app.

Usage:
  vp run dev:desktop:agent
  vp run dev:desktop:agent:url
  node scripts/dev-desktop-agent.ts run [--dry-run] [--workspace <id|-1|none>]
  node scripts/dev-desktop-agent.ts url

Commands:
  run        Restart this worktree's prior runner, then run dev:desktop.
  url        Print the live worktree instance's CDP origin.

Options:
  --dry-run              Resolve placement and port without writing state or starting processes.
  --workspace <selector> Override T3CODE_DESKTOP_AGENT_WORKSPACE for this run.
  -h, --help             Show this help before side effects.

Workspace selectors:
  none or unset  Let the compositor place the window normally (default).
  -1             Place one numbered workspace before the invoking app.
  <id>           Place on a fixed positive numbered workspace.

Environment:
  T3CODE_DESKTOP_AGENT_WORKSPACE is loaded from .env and .env.local.
  Precedence: --workspace, environment/repo env, default placement.

Exit codes:
  0 success
  1 runtime failure or no live URL
  2 invalid flags or usage
  130 interrupted by SIGINT

Output:
  run prints placement and CDP status, followed by dev:desktop output.
  url prints one loopback HTTP origin; errors are written to stderr.

Writes:
  run replaces this worktree's record below XDG_STATE_HOME and supervises a process group.
  url and --dry-run do not write or stop processes.
`;

export type DesktopAgentCommand =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly dryRun: boolean; readonly workspace: string | undefined }
  | { readonly kind: "url" };

export class DesktopAgentUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopAgentUsageError";
  }
}

function parseWorkspaceOption(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new DesktopAgentUsageError("--workspace requires a value");
  }
  const selector = value.trim();
  if (selector === "none" || selector === "-1") return selector;
  if (/^[1-9]\d*$/u.test(selector) && Number.isSafeInteger(Number(selector))) return selector;
  throw new DesktopAgentUsageError(
    `invalid --workspace value ${JSON.stringify(value)}; expected none, -1, or a positive workspace id`,
  );
}

export function parseDesktopAgentCommand(argv: readonly string[]): DesktopAgentCommand {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [command, ...options] = argv;
  if (command === "url") {
    if (options.length > 0) throw new DesktopAgentUsageError(`unknown argument: ${options[0]}`);
    return { kind: "url" };
  }
  if (command !== "run") {
    throw new DesktopAgentUsageError(command ? `unknown command: ${command}` : "missing command");
  }
  let dryRun = false;
  let workspace: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--dry-run") {
      if (dryRun) throw new DesktopAgentUsageError("--dry-run may be specified only once");
      dryRun = true;
      continue;
    }
    if (option === "--workspace") {
      if (workspace !== undefined) {
        throw new DesktopAgentUsageError("--workspace may be specified only once");
      }
      workspace = parseWorkspaceOption(options[index + 1]);
      index += 1;
      continue;
    }
    if (option?.startsWith("--workspace=")) {
      if (workspace !== undefined) {
        throw new DesktopAgentUsageError("--workspace may be specified only once");
      }
      workspace = parseWorkspaceOption(option.slice("--workspace=".length));
      continue;
    }
    throw new DesktopAgentUsageError(`unknown argument: ${String(option)}`);
  }
  return { kind: "run", dryRun, workspace };
}

export async function runDesktopAgentCli(argv: readonly string[]): Promise<number> {
  let command: DesktopAgentCommand;
  try {
    command = parseDesktopAgentCommand(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\nUsage: node scripts/dev-desktop-agent.ts <run|url>\n`);
    return 2;
  }
  if (command.kind === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  // Keep help and usage probes side-effect free. Runtime supervision is loaded
  // only after strict argv validation has selected an operational command.
  const runtimePath = ["./lib", "dev-desktop-agent.ts"].join("/");
  const runtime = (await import(runtimePath)) as {
    readonly runDesktopAgentCommand: (
      selected: Exclude<DesktopAgentCommand, { readonly kind: "help" }>,
    ) => Promise<number>;
  };
  return runtime.runDesktopAgentCommand(command);
}

if (import.meta.main) process.exitCode = await runDesktopAgentCli(process.argv.slice(2));
