/** Substitute once: text containing another placeholder must remain literal. */
export function expandVoiceTextTemplateFork(
  template: string,
  fields: Readonly<Record<string, string>>,
) {
  return template.replace(
    /\{\{([a-z_]+)\}\}/g,
    (placeholder, key: string) => fields[key] ?? placeholder,
  );
}

export function voiceRecentMessagesFork(
  messages: ReadonlyArray<{ role: string; text: string; streaming?: boolean }>,
  count: number,
) {
  if (count === 0) return "";
  const completed = messages.filter(
    (message) => !message.streaming && (message.role === "user" || message.role === "assistant"),
  );
  const lastUser = count === 2 ? completed.findLastIndex((message) => message.role === "user") : -1;
  const lastAssistant =
    count === 2 ? completed.findLastIndex((message) => message.role === "assistant") : -1;
  // With two messages, keep the most recent contribution from each side.
  const selected =
    count === 2
      ? completed.filter((_message, index) => index === lastUser || index === lastAssistant)
      : completed.slice(-count);
  const entries: string[] = [];
  let remaining = 12_000;
  for (const message of selected.toReversed()) {
    const header = `${message.role.toUpperCase()}:\n`;
    const separatorLength = entries.length ? 2 : 0;
    const bodyBudget = remaining - header.length - separatorLength;
    if (bodyBudget <= 0) break;
    const entry = header + message.text.slice(0, Math.min(4_000, bodyBudget));
    entries.unshift(entry);
    remaining -= entry.length + separatorLength;
  }
  return entries.join("\n\n");
}
