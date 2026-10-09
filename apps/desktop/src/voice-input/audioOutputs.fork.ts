// @effect-diagnostics nodeBuiltinImport:off - This OS adapter uses the desktop's PulseAudio-compatible control client.
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

export interface AudioOutputFork {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly volumes: readonly number[];
}

export interface AudioOutputsFork {
  list(): Promise<readonly AudioOutputFork[]>;
  setVolumes(id: string, volumes: readonly number[]): Promise<void>;
}

const Sinks = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    volume: Schema.Record(
      Schema.String,
      Schema.Struct({ value: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
    ),
  }),
);

const decodeSinks = Schema.decodeUnknownSync(Sinks);
const pactl = (args: string[]) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "pactl",
      args,
      { timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              "Could not control speaker volume. Check that pactl and PipeWire/PulseAudio are available.",
              { cause: error },
            ),
          );
        else resolve(stdout.trim());
      },
    );
  });

/** Sink names survive restarts; numeric sink indexes do not. Never changes mute state. */
export const linuxAudioOutputsFork: AudioOutputsFork = {
  async list() {
    const [json, defaultId] = await Promise.all([
      pactl(["--format=json", "list", "sinks"]),
      pactl(["get-default-sink"]),
    ]);
    return decodeSinks(JSON.parse(json))
      .map((sink) => ({
        id: sink.name,
        label: sink.description || sink.name,
        isDefault: sink.name === defaultId,
        volumes: Object.values(sink.volume).map((channel) => channel.value),
      }))
      .filter((sink) => sink.volumes.length > 0);
  },
  async setVolumes(id, volumes) {
    await pactl(["set-sink-volume", id, ...volumes.map((volume) => String(Math.round(volume)))]);
  },
};
