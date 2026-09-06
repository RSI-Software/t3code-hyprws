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

/** A walk repair carries `Fork-Repair`; nothing the fork stack replays ever does. */
export const isRepairMessage = (message: string): boolean => /^Fork-Repair:\s*\S/m.test(message);

/**
 * The replayed fork series, with the walk's own repair commits dropped. A repair is appended after
 * the replay, so counting or diffing `target..HEAD` raw would read the walk's own bookkeeping as a
 * changed stack; dropping it here keeps a real edit to any fork commit failing the walk.
 */
export const withoutRepairMessages = (
  messages: string,
): { readonly messages: string; readonly removed: number } => {
  const parts = messages.split("\x1e");
  const terminalSuffix = parts.pop() ?? "";
  const retained: Array<{ readonly index: number; readonly message: string }> = [];
  let removed = 0;
  for (const [index, part] of parts.entries()) {
    if (isRepairMessage(part)) {
      removed += 1;
      continue;
    }
    retained.push({ index, message: part });
  }
  if (removed === 0) return { messages, removed };
  const first = retained[0];
  if (first === undefined) return { messages: "", removed };
  const firstMessage = first.index > 0 ? first.message.replace(/^\n/, "") : first.message;
  return {
    messages:
      [firstMessage, ...retained.slice(1).map(({ message }) => message)].join("\x1e") +
      "\x1e" +
      terminalSuffix,
    removed,
  };
};
