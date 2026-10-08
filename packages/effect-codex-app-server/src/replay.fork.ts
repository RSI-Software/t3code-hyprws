/**
 * Mirrors `withoutConversationForkNoticeFork` in the server's `conversationFork.fork.ts`,
 * which this package cannot import. Recorded transcripts predate T3's conversation-fork
 * notice, so a frame compares as the turn text without it.
 */
export function withoutConversationForkNoticeFork(text: string) {
  const start = text.indexOf("[T3 Code conversation fork:");
  const closing = "[/T3 Code conversation fork]";
  const end = text.indexOf(closing, start);
  if (start === -1 || end === -1) return undefined;
  const before = text.slice(0, start);
  const after = text.slice(end + closing.length);
  return before === ""
    ? after.replace(/^\n\nUser message:\n/, "")
    : `${before.replace(/\n\n$/, "")}${after}`;
}
