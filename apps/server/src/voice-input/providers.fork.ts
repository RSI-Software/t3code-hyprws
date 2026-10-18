import type { VoiceInputProviderFork } from "@t3tools/contracts";

/** Presets fill the form; non-Meta services share the OpenAI upload and Realtime wires. Unsupported providers are visible stubs, never fallback engines. */
export const voiceInputProvidersFork = [
  {
    id: "meta",
    label: "Meta",
    available: true,
    endpoint: "https://api.meta.ai/v1/asr/transcribe",
    streamingEndpoint: "wss://api.meta.ai/v1/asr/realtime",
    model: "muse-voice-transcribe-1.0",
  },
  {
    id: "local",
    label: "Local HTTP",
    available: true,
    endpoint: "",
    streamingEndpoint: "",
    model: "",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible / custom",
    available: true,
    endpoint: "",
    streamingEndpoint: "",
    model: "",
  },
  {
    id: "openai",
    label: "OpenAI",
    available: true,
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    streamingEndpoint: "wss://api.openai.com/v1/realtime?intent=transcription",
    model: "",
  },
  {
    id: "groq",
    label: "Groq",
    available: true,
    endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
    streamingEndpoint: "",
    model: "",
  },
  {
    id: "mistral",
    label: "Mistral",
    available: true,
    endpoint: "https://api.mistral.ai/v1/audio/transcriptions",
    streamingEndpoint: "",
    model: "",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    available: false,
    endpoint: "https://api.elevenlabs.io/v1/speech-to-text",
    streamingEndpoint: "",
    model: "",
  },
  {
    id: "deepgram",
    label: "Deepgram",
    available: false,
    endpoint: "https://api.deepgram.com/v1/listen",
    streamingEndpoint: "",
    model: "",
  },
  {
    id: "assemblyai",
    label: "AssemblyAI",
    available: false,
    endpoint: "",
    streamingEndpoint: "",
    model: "",
  },
  { id: "azure", label: "Azure", available: false, endpoint: "", streamingEndpoint: "", model: "" },
  {
    id: "google",
    label: "Google Cloud",
    available: false,
    endpoint: "",
    streamingEndpoint: "",
    model: "",
  },
  { id: "aws", label: "AWS", available: false, endpoint: "", streamingEndpoint: "", model: "" },
] satisfies Array<{
  id: VoiceInputProviderFork;
  label: string;
  available: boolean;
  endpoint: string;
  streamingEndpoint: string;
  model: string;
}>;
