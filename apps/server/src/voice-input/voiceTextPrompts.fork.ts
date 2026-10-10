import {
  VOICE_TEXT_DEFAULT_PROMPTS_FORK,
  type VoiceTextConfigFork,
  type VoiceTextPromptKeyFork,
} from "@t3tools/contracts";

// Settings saved before prompts became optional hold copies of these first built-in prompts.
export const RETIRED_VOICE_TEXT_PROMPTS_FORK: Partial<Record<VoiceTextPromptKeyFork, string>> = {
  cleanupPrompt:
    "Correct this developer's transcription. Fix likely misheard technical terms, spelling, punctuation, and obvious speech disfluencies. Preserve meaning, uncertainty, requests, and the speaker's voice. Do not answer the request or add information. Use the context only as reference.\n\nProject context:\n{{project_context}}\n\nRecent conversation:\n{{recent_messages}}\n\nText to correct:\n{{text}}",
  formattingPrompt:
    "Format this draft for readability. Use paragraphs and, where useful, lists. Preserve its meaning, technical details, questions, and voice. Do not answer the request or add information. Use the context only as reference.\n\nProject context:\n{{project_context}}\n\nRecent conversation:\n{{recent_messages}}\n\nText to format:\n{{text}}",
};

/** Drops saved prompts that match a built-in default so they follow future default changes. */
export function normalizeVoiceTextConfigFork(config: VoiceTextConfigFork): VoiceTextConfigFork {
  const { cleanupPrompt, formattingPrompt, contextPrompt, ...rest } = config;
  const custom = (key: VoiceTextPromptKeyFork, value: string | undefined) =>
    value === undefined ||
    value === VOICE_TEXT_DEFAULT_PROMPTS_FORK[key] ||
    value === RETIRED_VOICE_TEXT_PROMPTS_FORK[key]
      ? undefined
      : value;
  const cleanup = custom("cleanupPrompt", cleanupPrompt);
  const formatting = custom("formattingPrompt", formattingPrompt);
  const context = custom("contextPrompt", contextPrompt);
  return {
    ...rest,
    ...(cleanup === undefined ? {} : { cleanupPrompt: cleanup }),
    ...(formatting === undefined ? {} : { formattingPrompt: formatting }),
    ...(context === undefined ? {} : { contextPrompt: context }),
  };
}

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
