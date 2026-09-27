/**
 * Fork: the launcher name embedded in the Linux desktop entry, so a fork
 * AppImage reads as the fork in app menus (RSI-Software/t3code-hyprws#176).
 * Only the entry's `Name` changes: `productName` still derives the user-data
 * directory, and the app id, executable, and URL schemes stay upstream's.
 */
export function forkDesktopEntryName(channel: "latest" | "nightly"): string {
  return channel === "nightly" ? "T3 Code (hyprws Nightly)" : "T3 Code (hyprws)";
}
