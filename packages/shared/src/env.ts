export const INHERITED_TMUX_ENV_KEYS = ["TMUX", "TMUX_PANE", "TMUX_TMPDIR"] as const;

const inheritedTmuxEnvKeys = new Set<string>(INHERITED_TMUX_ENV_KEYS);

export function isInheritedTmuxEnvKey(key: string): boolean {
  return inheritedTmuxEnvKeys.has(key.toUpperCase());
}

export function stripInheritedTmuxEnv(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const scrubbed = { ...environment };
  for (const key of Object.keys(scrubbed)) {
    if (isInheritedTmuxEnvKey(key)) {
      delete scrubbed[key];
    }
  }
  return scrubbed;
}
