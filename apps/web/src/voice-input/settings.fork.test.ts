import type { VoiceInputSettingsFork } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { voiceInputUnavailableReasonFork } from "./settings.fork";

const meta: VoiceInputSettingsFork = {
  enabled: true,
  provider: "meta",
  baseUrl: "https://api.meta.ai/v1",
  live: true,
  model: "muse-voice-transcribe-1.0",
  hasApiKey: false,
};

it("requires a saved Meta key before offering recording", () => {
  expect(voiceInputUnavailableReasonFork(meta)).toContain("API key");
  expect(voiceInputUnavailableReasonFork({ ...meta, hasApiKey: true })).toBeNull();
});

it("requires loaded, enabled settings with a base URL and model", () => {
  const custom = { ...meta, provider: "openai-compatible" as const };
  expect(voiceInputUnavailableReasonFork(null)).not.toBeNull();
  expect(voiceInputUnavailableReasonFork({ ...custom, enabled: false })).toContain("Enable");
  expect(voiceInputUnavailableReasonFork({ ...custom, baseUrl: " " })).toContain("base URL");
  expect(voiceInputUnavailableReasonFork({ ...custom, model: "" })).toContain("model");
  expect(voiceInputUnavailableReasonFork(custom)).toBeNull();
});
