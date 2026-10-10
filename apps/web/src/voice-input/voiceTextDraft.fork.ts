import type { VoiceDraftSnapshot } from "@t3tools/client-runtime/voice-input";
import type { VoiceTextConfigFork } from "@t3tools/contracts";
import { replaceTextRange } from "@t3tools/shared/composerTrigger";

export function sameVoiceTextDraftFork(captured: VoiceDraftSnapshot, current: VoiceDraftSnapshot) {
  return (
    captured.ownerKey === current.ownerKey &&
    captured.revision === current.revision &&
    captured.text === current.text
  );
}

export function voiceTextReplacementFork(
  draft: VoiceDraftSnapshot,
  operation: "cleanup" | "format",
  text: string,
) {
  const selection =
    operation === "cleanup" && draft.selection.start !== draft.selection.end
      ? draft.selection
      : { start: 0, end: draft.text.length };
  return replaceTextRange(draft.text, selection.start, selection.end, text);
}

export function autoVoiceFormattingFork(config: VoiceTextConfigFork, text: string) {
  return (
    config.formattingMode === "auto" &&
    (text.match(/\S+/g)?.length ?? 0) >= config.formattingMinWords
  );
}
