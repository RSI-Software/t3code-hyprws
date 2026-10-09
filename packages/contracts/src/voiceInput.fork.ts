import * as Schema from "effect/Schema";

export const VOICE_INPUT_ROUTE_FORK = "/api/fork/voice-input";
export const VOICE_INPUT_MAX_BYTES_FORK = 16 * 1024 * 1024;

export const VoiceInputProviderFork = Schema.Literals([
  "meta",
  "local",
  "openai-compatible",
  "openai",
  "groq",
  "mistral",
  "elevenlabs",
  "deepgram",
  "assemblyai",
  "azure",
  "google",
  "aws",
]);
export type VoiceInputProviderFork = typeof VoiceInputProviderFork.Type;

export const VoiceInputConfigFork = Schema.Struct({
  enabled: Schema.Boolean,
  provider: VoiceInputProviderFork,
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  model: Schema.String.check(Schema.isMaxLength(200)),
});
export type VoiceInputConfigFork = typeof VoiceInputConfigFork.Type;

/** An omitted key retains it only when the provider and endpoint are unchanged. */
export const VoiceInputConfigUpdateFork = Schema.Struct({
  ...VoiceInputConfigFork.fields,
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});
export type VoiceInputConfigUpdateFork = typeof VoiceInputConfigUpdateFork.Type;

export const VoiceInputSettingsFork = Schema.Struct({
  ...VoiceInputConfigFork.fields,
  hasApiKey: Schema.Boolean,
  providers: Schema.Array(
    Schema.Struct({
      id: VoiceInputProviderFork,
      label: Schema.String,
      available: Schema.Boolean,
      endpoint: Schema.String,
      model: Schema.String,
    }),
  ),
});
export type VoiceInputSettingsFork = typeof VoiceInputSettingsFork.Type;

export const VoiceInputTranscriptFork = Schema.Struct({ text: Schema.String });
