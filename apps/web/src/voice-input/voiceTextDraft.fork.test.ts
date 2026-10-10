import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  VOICE_TEXT_STARTER_PROMPTS_FORK,
  type VoiceTextConfigFork,
} from "@t3tools/contracts";
import {
  autoVoiceFormattingFork,
  sameVoiceTextDraftFork,
  voiceTextReplacementFork,
} from "./voiceTextDraft.fork";

const draft = {
  ownerKey: "thread-a",
  revision: 1,
  text: "Keep this. react use affect is broke",
  selection: { start: 11, end: 36 },
};
const config: VoiceTextConfigFork = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  cleanupMode: "manual",
  formattingMode: "auto",
  formattingMinWords: 50,
  recentMessageCount: 0,
  projectContext: "",
  ...VOICE_TEXT_STARTER_PROMPTS_FORK,
};
describe("dictation draft transformations", () => {
  it("cleans a selection without changing the surrounding draft", () => {
    expect(voiceTextReplacementFork(draft, "cleanup", "React useEffect is broken.").text).toBe(
      "Keep this. React useEffect is broken.",
    );
  });
  it("formats the whole draft even when a selection exists", () => {
    expect(
      voiceTextReplacementFork(draft, "format", "Keep this.\n\nReact useEffect is broken.").text,
    ).toBe("Keep this.\n\nReact useEffect is broken.");
  });
  it("rejects results after edits, edit-and-revert, or switching draft owners", () => {
    expect(sameVoiceTextDraftFork(draft, { ...draft })).toBe(true);
    expect(sameVoiceTextDraftFork(draft, { ...draft, text: "newer draft" })).toBe(false);
    expect(sameVoiceTextDraftFork(draft, { ...draft, revision: 3 })).toBe(false);
    expect(sameVoiceTextDraftFork(draft, { ...draft, ownerKey: "thread-b" })).toBe(false);
  });
  it("runs automatic formatting at the configured threshold only in automatic mode", () => {
    expect(autoVoiceFormattingFork(config, "word ".repeat(49))).toBe(false);
    expect(autoVoiceFormattingFork(config, "word ".repeat(50))).toBe(true);
    expect(
      autoVoiceFormattingFork({ ...config, formattingMode: "manual" }, "word ".repeat(50)),
    ).toBe(false);
    expect(autoVoiceFormattingFork({ ...config, formattingMinWords: 2 }, "two words")).toBe(true);
  });
});
