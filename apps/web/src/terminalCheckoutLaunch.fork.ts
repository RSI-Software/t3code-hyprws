import { projectScriptCwd } from "@t3tools/shared/projectScripts";

interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

export function terminalCheckoutLaunchIdentity(input: {
  readonly attachmentId: string;
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly runtimeEnv?: Readonly<Record<string, string>>;
}): string {
  const runtimeEnvKey = input.runtimeEnv
    ? JSON.stringify(
        Object.entries(input.runtimeEnv)
          .filter(([key, value]) => key.length > 0 && typeof value === "string")
          .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
      )
    : "";
  return `${input.attachmentId}\0${input.cwd}\0${input.worktreePath ?? ""}\0${runtimeEnvKey}`;
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
