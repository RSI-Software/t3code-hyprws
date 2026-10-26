import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import prompts from "./voiceText.defaults.fork.json" with { type: "json" };

export const VoiceTextHttpErrorFork = Schema.Struct({
  error: Schema.String,
  code: Schema.String,
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export const isVoiceTextHttpErrorFork = Schema.is(VoiceTextHttpErrorFork);

/** Editable starter values; saved environment and project settings own every prompt. */
export const VOICE_TEXT_STARTER_PROMPTS_FORK = prompts;
const prompt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
export const VoiceTextModeFork = Schema.Literals(["off", "manual", "auto"]);
export type VoiceTextModeFork = typeof VoiceTextModeFork.Type;
export const VoiceTextConfigFork = Schema.Struct({
  modelSelection: ModelSelection,
  cleanupMode: VoiceTextModeFork,
  formattingMode: VoiceTextModeFork,
  formattingMinWords: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  recentMessageCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
  cleanupPrompt: prompt,
  formattingPrompt: prompt,
  contextPrompt: prompt,
  projectContext: Schema.String.check(Schema.isMaxLength(20_000)),
  /** One term per line; `heard, misheard -> Term` adds a spelling rule. Sent to the speech service. */
  terms: Schema.String.check(Schema.isMaxLength(20_000)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
});
export type VoiceTextConfigFork = typeof VoiceTextConfigFork.Type;
export const VoiceTextSettingsFork = Schema.Struct({
  defaults: VoiceTextConfigFork,
  projects: Schema.Record(Schema.String, VoiceTextConfigFork),
});
export type VoiceTextSettingsFork = typeof VoiceTextSettingsFork.Type;
export const VoiceTextConfigureFork = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  config: Schema.NullOr(VoiceTextConfigFork),
});
export type VoiceTextConfigureFork = typeof VoiceTextConfigureFork.Type;
export const VoiceTextTransformFork = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  operation: Schema.Literals(["cleanup", "format"]),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
});
export type VoiceTextTransformFork = typeof VoiceTextTransformFork.Type;
export const VoiceTextContextFork = Schema.Struct({
  projectId: ProjectId,
  config: Schema.optionalKey(VoiceTextConfigFork),
});
export type VoiceTextContextFork = typeof VoiceTextContextFork.Type;
