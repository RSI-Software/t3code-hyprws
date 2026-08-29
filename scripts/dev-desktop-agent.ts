#!/usr/bin/env node

/** Start, restart, or inspect this worktree's agent-placed desktop dev app. */

const HELP = `Start or inspect the worktree's agent-placed desktop development app.

Usage:
  vp run dev:desktop:agent
  vp run dev:desktop:agent:url
  node scripts/dev-desktop-agent.ts run [--dry-run]
  node scripts/dev-desktop-agent.ts url

Commands:
  run        Restart this worktree's prior runner, then run dev:desktop.
  url        Print the live worktree instance's CDP origin.

Options:
  --dry-run  Resolve workspace and port without writing state or starting processes.
  -h, --help Show this help before side effects.

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
  | { readonly kind: "run"; readonly dryRun: boolean }
  | { readonly kind: "url" };

export class DesktopAgentUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopAgentUsageError";
  }
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
  for (const option of options) {
    if (option !== "--dry-run") throw new DesktopAgentUsageError(`unknown argument: ${option}`);
    if (dryRun) throw new DesktopAgentUsageError("--dry-run may be specified only once");
    dryRun = true;
  }
  return { kind: "run", dryRun };
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
