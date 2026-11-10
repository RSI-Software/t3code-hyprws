import * as Schema from "effect/Schema";

export const SPEECH_REMOTE_MODEL_ROUTE_FORK = "/api/fork/speech-remote-model";
/** Stable across model renames, so the environment's selection survives an edit. */
export const SPEECH_REMOTE_MODEL_ID_FORK = "fork/remote";

/** An OpenAI-compatible transcription service the environment forwards audio to. */
export const SpeechRemoteModelConfigFork = Schema.Struct({
  /** API root such as `https://api.openai.com/v1`; upload and Realtime paths derive from it. */
  baseUrl: Schema.String.check(Schema.isMaxLength(2048)),
  model: Schema.String.check(Schema.isMaxLength(200)),
  /** Streams a live preview over OpenAI Realtime transcription. */
  live: Schema.Boolean,
});
export type SpeechRemoteModelConfigFork = typeof SpeechRemoteModelConfigFork.Type;

/** An omitted key keeps the saved one while the base URL is unchanged. */
export const SpeechRemoteModelUpdateFork = Schema.Struct({
  ...SpeechRemoteModelConfigFork.fields,
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});
export type SpeechRemoteModelUpdateFork = typeof SpeechRemoteModelUpdateFork.Type;

export const SpeechRemoteModelSettingsFork = Schema.Struct({
  ...SpeechRemoteModelConfigFork.fields,
  hasApiKey: Schema.Boolean,
});
export type SpeechRemoteModelSettingsFork = typeof SpeechRemoteModelSettingsFork.Type;
