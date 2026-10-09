import type { VoiceInputProviderFork } from "@t3tools/contracts";

/** Unsupported providers are visible configuration stubs, never fallback engines. */
export const voiceInputProvidersFork = [
  {
    id: "meta",
    label: "Meta",
    available: false,
    endpoint: "https://api.meta.ai/v1/asr/transcribe",
    model: "muse-voice-transcribe-1.0",
  },
  { id: "local", label: "Local HTTP", available: true, endpoint: "", model: "" },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible / custom",
    available: true,
    endpoint: "",
    model: "",
  },
  {
    id: "openai",
    label: "OpenAI",
    available: false,
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    model: "",
  },
  {
    id: "groq",
    label: "Groq",
    available: false,
    endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: "",
  },
  {
    id: "mistral",
    label: "Mistral",
    available: false,
    endpoint: "https://api.mistral.ai/v1/audio/transcriptions",
    model: "",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    available: false,
    endpoint: "https://api.elevenlabs.io/v1/speech-to-text",
    model: "",
  },
  {
    id: "deepgram",
    label: "Deepgram",
    available: false,
    endpoint: "https://api.deepgram.com/v1/listen",
    model: "",
  },
  { id: "assemblyai", label: "AssemblyAI", available: false, endpoint: "", model: "" },
  { id: "azure", label: "Azure", available: false, endpoint: "", model: "" },
  { id: "google", label: "Google Cloud", available: false, endpoint: "", model: "" },
  { id: "aws", label: "AWS", available: false, endpoint: "", model: "" },
] satisfies Array<{
  id: VoiceInputProviderFork;
  label: string;
  available: boolean;
  endpoint: string;
  model: string;
}>;
