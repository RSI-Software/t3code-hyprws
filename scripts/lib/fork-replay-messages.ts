/**
 * Normalize one `%B` message the way `git commit --cleanup=default` does: trailing whitespace
 * goes, a run of blank lines collapses to one, and leading and trailing blank lines go. Only
 * whitespace moves, so every line's text — `Fork-Domain` and `Fork-Tier` trailers included —
 * still has to match exactly.
 */
export const normalizeCommitMessage = (message: string): string => {
  const normalized: Array<string> = [];
  for (const raw of message.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line === "" && (normalized.length === 0 || normalized[normalized.length - 1] === ""))
      continue;
    normalized.push(line);
  }
  while (normalized.length > 0 && normalized[normalized.length - 1] === "") normalized.pop();
  return normalized.join("\n");
};

/**
 * `git rebase` recommits every message through its own cleanup, so a stored message that was
 * not already normalized comes back with a trailing newline added or a blank run collapsed.
 * Comparing both sides through the same normalization keeps that rewrite from reading as a
 * changed message while a real edit to any line still fails the walk.
 */
export const normalizeReplayMessages = (messages: string): string =>
  messages.split("\x1e").map(normalizeCommitMessage).join("\x1e");
