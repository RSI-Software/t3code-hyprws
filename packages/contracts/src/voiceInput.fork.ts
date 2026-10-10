import * as Schema from "effect/Schema";

export * from "./voiceText.fork.ts";

export const VOICE_INPUT_ROUTE_FORK = "/api/fork/voice-input";
export const VOICE_INPUT_MAX_BYTES_FORK = 16 * 1024 * 1024;

/** Meta speaks its own ASR wire; every other service speaks OpenAI's. */
export const VoiceInputProviderFork = Schema.Literals(["openai-compatible", "meta"]);
export type VoiceInputProviderFork = typeof VoiceInputProviderFork.Type;

export const VoiceInputConfigFork = Schema.Struct({
  enabled: Schema.Boolean,
  provider: VoiceInputProviderFork,
  /** API root such as `https://api.openai.com/v1`; upload and realtime paths derive from it. */
  baseUrl: Schema.String.check(Schema.isMaxLength(2048)),
  /** Streams a live preview; off uploads the whole recording after Stop. */
  live: Schema.Boolean,
  model: Schema.String.check(Schema.isMaxLength(200)),
});
export type VoiceInputConfigFork = typeof VoiceInputConfigFork.Type;

/** An omitted key retains it only when the provider and base URL are unchanged. */
export const VoiceInputConfigUpdateFork = Schema.Struct({
  ...VoiceInputConfigFork.fields,
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});
export type VoiceInputConfigUpdateFork = typeof VoiceInputConfigUpdateFork.Type;

export const VoiceInputSettingsFork = Schema.Struct({
  ...VoiceInputConfigFork.fields,
  hasApiKey: Schema.Boolean,
});
export type VoiceInputSettingsFork = typeof VoiceInputSettingsFork.Type;

export const VoiceInputTranscriptFork = Schema.Struct({ text: Schema.String });
