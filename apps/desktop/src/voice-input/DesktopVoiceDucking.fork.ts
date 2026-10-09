import type { VoiceDuckingOutputsFork, VoiceDuckingSettingsFork } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { linuxAudioOutputsFork } from "./audioOutputs.fork.ts";
import { SpeakerDuckingFork } from "./ducking.fork.ts";

export class VoiceDuckingErrorFork extends Schema.TaggedError<VoiceDuckingErrorFork>()(
  "VoiceDuckingErrorFork",
  { message: Schema.String },
) {}
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new VoiceDuckingErrorFork({
        message: error instanceof Error ? error.message : "Speaker ducking failed.",
      }),
  });

export class DesktopVoiceDuckingFork extends Context.Service<
  DesktopVoiceDuckingFork,
  {
    readonly list: Effect.Effect<VoiceDuckingOutputsFork>;
    readonly start: (
      owner: number,
      sessionId: string,
      settings: VoiceDuckingSettingsFork,
    ) => Effect.Effect<void, VoiceDuckingErrorFork>;
    readonly stop: (owner: number, sessionId: string) => Effect.Effect<void, VoiceDuckingErrorFork>;
  }
>()("@t3tools/desktop/voice-input/DesktopVoiceDucking.fork/DesktopVoiceDuckingFork") {}

export const layer = Layer.effect(
  DesktopVoiceDuckingFork,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const unsupported =
      environment.platform === "linux"
        ? null
        : "Speaker ducking currently supports Linux with PipeWire or PulseAudio.";
    let runBackground = Effect.runForkWith(yield* Effect.context<never>());
    const warn = (error: unknown) => {
      runBackground(Effect.logWarning("Speaker ducking:", error));
    };
    const manager = new SpeakerDuckingFork(linuxAudioOutputsFork, warn, undefined, (message) => {
      runBackground(
        Effect.void.pipe(
          Effect.withSpan("desktop.voiceDucking.state", { attributes: { message } }),
        ),
      );
    });
    const watchers = new Map<number, () => void>();
    const watchOwner = (id: number) => {
      if (watchers.has(id)) return;
      const contents = Electron.webContents.fromId(id);
      if (!contents || contents.isDestroyed())
        throw new Error("Recording window is no longer available.");
      const release = () => {
        void manager.stop(id).catch(warn);
      };
      const navigation = (
        _event: Electron.Event,
        _url: string,
        _inPlace: boolean,
        mainFrame: boolean,
      ) => {
        if (mainFrame) release();
      };
      const cleanup = () => {
        contents.removeListener("destroyed", destroyed);
        contents.removeListener("render-process-gone", release);
        contents.removeListener("did-start-navigation", navigation);
        watchers.delete(id);
      };
      const destroyed = () => {
        release();
        cleanup();
      };
      contents.once("destroyed", destroyed);
      contents.on("render-process-gone", release);
      contents.on("did-start-navigation", navigation);
      watchers.set(id, cleanup);
    };
    yield* Effect.addFinalizer(() =>
      attempt(async () => {
        for (const cleanup of watchers.values()) cleanup();
        await manager.close();
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not restore speaker volume on shutdown.", error),
        ),
      ),
    );
    return DesktopVoiceDuckingFork.of({
      list: unsupported
        ? Effect.succeed({ unavailableReason: unsupported, outputs: [] })
        : attempt(async () => ({
            unavailableReason: null,
            outputs: (await linuxAudioOutputsFork.list()).map(({ id, label, isDefault }) => ({
              id,
              label,
              isDefault,
            })),
          })).pipe(
            Effect.catch((error) =>
              Effect.succeed({ unavailableReason: error.message, outputs: [] }),
            ),
          ),
      start: (owner, sessionId, settings) =>
        Effect.gen(function* () {
          // IPC runs with the installed tracer; foundation construction precedes it.
          runBackground = Effect.runForkWith(yield* Effect.context<never>());
          yield* attempt(async () => {
            if (unsupported) throw new Error(unsupported);
            watchOwner(owner);
            await manager.start(owner, sessionId, settings);
            if (Electron.webContents.fromId(owner)?.isDestroyed() !== false)
              await manager.stop(owner);
          });
        }),
      stop: (owner, sessionId) => attempt(() => manager.stop(owner, sessionId)),
    });
  }),
);
