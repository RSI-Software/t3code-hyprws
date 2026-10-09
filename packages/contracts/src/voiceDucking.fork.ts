import * as Schema from "effect/Schema";

export const VOICE_DUCKING_DEFAULT_OUTPUT_FORK = "system-default";
const OutputId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const FadeTime = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));

export const VoiceDuckingSettingsFork = Schema.Struct({
  enabled: Schema.Boolean,
  outputIds: Schema.Array(OutputId).check(Schema.isMaxLength(64)),
  targetPercent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  fadeDownMs: FadeTime,
  fadeUpMs: FadeTime,
});
export type VoiceDuckingSettingsFork = typeof VoiceDuckingSettingsFork.Type;

export const DEFAULT_VOICE_DUCKING_SETTINGS_FORK: VoiceDuckingSettingsFork = {
  enabled: false,
  outputIds: [VOICE_DUCKING_DEFAULT_OUTPUT_FORK],
  targetPercent: 20,
  fadeDownMs: 0,
  fadeUpMs: 1000,
};

export const VoiceDuckingOutputsFork = Schema.Struct({
  unavailableReason: Schema.NullOr(Schema.String),
  outputs: Schema.Array(
    Schema.Struct({ id: OutputId, label: Schema.String, isDefault: Schema.Boolean }),
  ),
});
export type VoiceDuckingOutputsFork = typeof VoiceDuckingOutputsFork.Type;

export const VoiceDuckingStartFork = Schema.Struct({
  sessionId: OutputId,
  settings: VoiceDuckingSettingsFork,
});

export interface VoiceDuckingBridgeFork {
  listOutputs: () => Promise<VoiceDuckingOutputsFork>;
  start: (sessionId: string, settings: VoiceDuckingSettingsFork) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
}
