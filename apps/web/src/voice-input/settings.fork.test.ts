import type { VoiceInputSettingsFork } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { voiceInputUnavailableReasonFork } from "./settings.fork";

const meta: VoiceInputSettingsFork = {
  enabled: true,
  provider: "meta",
  endpoint: "https://api.meta.ai/v1/asr/transcribe",
  model: "muse-voice-transcribe-1.0",
  hasApiKey: false,
  providers: [
    { id: "meta", label: "Meta", available: true, endpoint: "", model: "" },
    { id: "local", label: "Local HTTP", available: true, endpoint: "", model: "" },
    {
      id: "openai-compatible",
      label: "OpenAI-compatible / custom",
      available: true,
      endpoint: "",
      model: "",
    },
  ],
};

it("requires a saved Meta key before offering recording", () => {
  expect(voiceInputUnavailableReasonFork(meta)).toContain("API key");
  expect(voiceInputUnavailableReasonFork({ ...meta, hasApiKey: true })).toBeNull();
});

it("requires loaded, enabled, supported settings", () => {
  expect(voiceInputUnavailableReasonFork(null)).not.toBeNull();
  expect(voiceInputUnavailableReasonFork({ ...meta, enabled: false })).toContain("Enable");
  expect(voiceInputUnavailableReasonFork({ ...meta, provider: "openai" })).toContain("available");
});

it("accepts local HTTP without a model or key once an endpoint is set", () => {
  const local = { ...meta, provider: "local" as const, model: "", endpoint: "" };
  expect(voiceInputUnavailableReasonFork(local)).toContain("endpoint");
  expect(
    voiceInputUnavailableReasonFork({ ...local, endpoint: "http://localhost:19762/transcribe" }),
  ).toBeNull();
});

it("requires the model for multipart services but leaves their key optional", () => {
  const custom = { ...meta, provider: "openai-compatible" as const, model: "" };
  expect(voiceInputUnavailableReasonFork(custom)).toContain("model");
  expect(voiceInputUnavailableReasonFork({ ...custom, model: "whisper" })).toBeNull();
});
