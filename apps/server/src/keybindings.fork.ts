/**
 * Fork-only: command ids the fork renamed, mapped to their current id
 * (RSI-Software/t3code-hyprws#1343). A saved keybindings file still naming an
 * old id would otherwise fail to decode, and one invalid entry blocks the
 * startup sync of new defaults.
 */
const RENAMED_KEYBINDING_COMMANDS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["project.openWindow", "window.openInNew"],
];

/**
 * Rewrites renamed command ids in the raw keybindings file text. Works on the
 * text, not parsed JSON, because the file is read leniently (comments,
 * trailing commas) and must stay byte-identical otherwise.
 */
export function migrateRenamedKeybindingCommands(rawConfig: string): string {
  let migrated = rawConfig;
  for (const [from, to] of RENAMED_KEYBINDING_COMMANDS) {
    const pattern = new RegExp(`("command"\\s*:\\s*)"${from.replaceAll(".", "\\.")}"`, "gu");
    migrated = migrated.replace(pattern, `$1"${to}"`);
  }
  return migrated;
}
