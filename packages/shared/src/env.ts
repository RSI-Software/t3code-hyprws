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

interface HarnessIdentityEnvKeys {
  readonly exact: readonly string[];
  readonly prefixes: readonly string[];
}

/**
 * Environment variables a coding-agent CLI sets to describe its own run,
 * keyed by the provider driver kind that owns them. Tooling an agent runs
 * reads these to name the harness it is running under, so a provider spawned
 * from a host that carries another provider's markers must not inherit them.
 *
 * Credentials (`ANTHROPIC_API_KEY`, `XAI_API_KEY`) are deliberately absent:
 * they belong to the user, not to a harness run, and any provider may use them.
 */
export const HARNESS_IDENTITY_ENV: Readonly<Record<string, HarnessIdentityEnvKeys>> = {
  claudeAgent: { exact: ["CLAUDECODE"], prefixes: ["CLAUDE_"] },
  codex: { exact: [], prefixes: ["CODEX_"] },
  cursor: { exact: [], prefixes: ["CURSOR_"] },
  grok: { exact: [], prefixes: ["GROK_"] },
  opencode: { exact: [], prefixes: ["OPENCODE_"] },
};

function ownsEnvKey(keys: HarnessIdentityEnvKeys, upperKey: string): boolean {
  return (
    keys.exact.includes(upperKey) || keys.prefixes.some((prefix) => upperKey.startsWith(prefix))
  );
}

/**
 * `ownDriverKind` is the driver kind the variable would be handed to. An
 * unknown kind owns nothing, so every harness marker reads as foreign to it.
 */
export function isForeignHarnessIdentityEnvKey(key: string, ownDriverKind?: string): boolean {
  const upperKey = key.toUpperCase();
  for (const [driverKind, keys] of Object.entries(HARNESS_IDENTITY_ENV)) {
    if (driverKind === ownDriverKind) continue;
    if (ownsEnvKey(keys, upperKey)) return true;
  }
  return false;
}

/**
 * Removes every harness identity variable that belongs to a provider other
 * than `ownDriverKind`. Omit `ownDriverKind` to remove all of them, which is
 * what a spawn seam wants when the caller layers the target provider's own
 * environment back on top.
 *
 * `T3CODE_*` session identity is not harness identity and is always kept.
 */
export function stripForeignHarnessIdentityEnv(
  environment: Readonly<Record<string, string | undefined>>,
  ownDriverKind?: string,
): Record<string, string | undefined> {
  const scrubbed = { ...environment };
  for (const key of Object.keys(scrubbed)) {
    if (isForeignHarnessIdentityEnvKey(key, ownDriverKind)) {
      delete scrubbed[key];
    }
  }
  return scrubbed;
}
