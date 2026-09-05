import { projectScriptCwd } from "@t3tools/shared/projectScripts";

interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

export function resolveTerminalCheckoutLaunch(input: {
  readonly mode: "follow" | "pin";
  readonly projectCwd: string;
  readonly selectedWorktreePath: string | null | undefined;
  readonly requested: TerminalLaunchLocation | null;
  readonly current: TerminalLaunchLocation | null;
}): TerminalLaunchLocation {
  if (input.mode === "pin" && input.current) {
    return input.current;
  }

  const worktreePath =
    input.selectedWorktreePath !== undefined
      ? input.selectedWorktreePath
      : (input.requested?.worktreePath ?? input.current?.worktreePath ?? null);
  const matchingRequest = input.requested?.worktreePath === worktreePath ? input.requested : null;
  return {
    cwd:
      matchingRequest?.cwd ??
      projectScriptCwd({ project: { cwd: input.projectCwd }, worktreePath }),
    worktreePath,
  };
}
