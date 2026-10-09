// @effect-diagnostics globalDate:off - The imperative audio ramp shares its clock with the injected fake-timer tests.
// @effect-diagnostics globalTimers:off - The ramp owns one cancellable timer, cleared by the desktop service finalizer.
import {
  VOICE_DUCKING_DEFAULT_OUTPUT_FORK,
  type VoiceDuckingSettingsFork,
} from "@t3tools/contracts";
import type { AudioOutputFork, AudioOutputsFork } from "./audioOutputs.fork.ts";

type Session = { owner: number; ids: readonly string[]; settings: VoiceDuckingSettingsFork };
type Output = {
  original: readonly number[];
  last: readonly number[];
  target: readonly number[];
  fadeUpMs: number;
  manual: boolean;
  needsReadback: boolean;
  transition: { from: readonly number[]; started: number; duration: number } | null;
};
const sameVolume = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= 2);

/** One owner per recording, one original volume per output across every desktop window. */
export class SpeakerDuckingFork {
  private sessions = new Map<string, Session>();
  private outputs = new Map<string, Output>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly audio: AudioOutputsFork;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  private readonly trace: (message: string) => void;

  constructor(
    audio: AudioOutputsFork,
    onError: (error: unknown) => void,
    now = () => Date.now(),
    trace = (_message: string) => {},
  ) {
    this.audio = audio;
    this.onError = onError;
    this.now = now;
    this.trace = trace;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  start(owner: number, sessionId: string, settings: VoiceDuckingSettingsFork) {
    return this.enqueue(async () => {
      if (this.closed) throw new Error("Speaker ducking is shutting down.");
      if (!settings.enabled) return;
      const key = `${owner}:${sessionId}`;
      if (this.sessions.has(key)) return;
      const available = await this.audio.list();
      const ids = available
        .filter(
          (output) =>
            settings.outputIds.includes(output.id) ||
            (output.isDefault && settings.outputIds.includes(VOICE_DUCKING_DEFAULT_OUTPUT_FORK)),
        )
        .map((output) => output.id);
      if (ids.length === 0)
        throw new Error("No selected speaker output is available. Check Dictation settings.");
      this.sessions.set(key, { owner, ids, settings });
      this.trace(`Ducking start ${key}: ${JSON.stringify({ ids, settings, available })}`);
      for (const id of ids) {
        if (this.outputs.has(id)) continue;
        const original = available.find((output) => output.id === id)!.volumes;
        this.outputs.set(id, {
          original,
          last: original,
          target: original,
          fadeUpMs: settings.fadeUpMs,
          manual: false,
          needsReadback: false,
          transition: null,
        });
      }
      try {
        this.retarget(available, settings.fadeDownMs);
        await this.step(available);
      } catch (error) {
        this.sessions.delete(key);
        // Roll back every output already changed if another output failed.
        try {
          const current = await this.audio.list();
          this.retarget(current, 0, true);
          await this.step(current);
        } catch (restoreError) {
          this.onError(restoreError);
          this.schedule();
        }
        throw error;
      }
      this.schedule();
    });
  }

  stop(owner: number, sessionId?: string) {
    return this.enqueue(async () => {
      for (const [key, session] of this.sessions) {
        if (session.owner === owner && (sessionId === undefined || key === `${owner}:${sessionId}`))
          this.sessions.delete(key);
      }
      if (this.outputs.size === 0) return;
      this.trace(
        `Ducking stop ${owner}:${sessionId ?? "all"}: ${JSON.stringify({ remaining: [...this.sessions.keys()], outputs: [...this.outputs] })}`,
      );
      try {
        const current = await this.audio.list();
        this.retarget(current, 0);
        await this.step(current);
      } finally {
        this.schedule();
      }
    });
  }

  private retarget(current: readonly AudioOutputFork[], fadeDownMs: number, immediate = false) {
    for (const [id, output] of this.outputs) {
      const device = current.find((item) => item.id === id);
      const claims = [...this.sessions.values()].filter((session) => session.ids.includes(id));
      // A failed write/readback is reconciled before rollback or retry.
      if (output.needsReadback && device) {
        output.last = device.volumes;
        output.needsReadback = false;
      }
      // A changed channel count belongs to a different device profile; never overwrite it.
      if (!device || !sameVolume(device.volumes, output.last)) {
        if (!output.manual)
          this.trace(
            `Ducking volume changed ${id}: ${JSON.stringify({ expected: output.last, observed: device?.volumes, original: output.original })}`,
          );
        output.manual = true;
      }
      if (output.manual) {
        output.transition = null;
        if (claims.length === 0) this.outputs.delete(id);
        continue;
      }
      const ratio = claims.length
        ? Math.min(...claims.map((session) => session.settings.targetPercent)) / 100
        : 1;
      const target = output.original.map((volume) => Math.round(volume * ratio));
      if (claims.length)
        output.fadeUpMs = Math.max(...claims.map((session) => session.settings.fadeUpMs));
      if (sameVolume(target, output.target)) {
        if (!claims.length && !output.transition) this.outputs.delete(id);
        continue;
      }
      const goingDown = target.some((volume, index) => volume < output.last[index]!);
      output.target = target;
      output.transition = {
        from: output.last,
        started: this.now(),
        duration: immediate ? 0 : goingDown ? fadeDownMs : output.fadeUpMs,
      };
    }
  }

  private async step(current: readonly AudioOutputFork[]) {
    for (const [id, output] of this.outputs) {
      if (!output.transition) continue;
      const device = current.find((item) => item.id === id);
      if (!device || !sameVolume(device.volumes, output.last)) {
        this.trace(
          `Ducking fade volume changed ${id}: ${JSON.stringify({ expected: output.last, observed: device?.volumes, original: output.original })}`,
        );
        output.manual = true;
        output.transition = null;
        if (![...this.sessions.values()].some((session) => session.ids.includes(id)))
          this.outputs.delete(id);
        continue;
      }
      const { from, started, duration } = output.transition;
      const progress = duration === 0 ? 1 : Math.min(1, (this.now() - started) / duration);
      const next = from.map((volume, index) =>
        Math.round(volume + (output.target[index]! - volume) * progress),
      );
      if (!sameVolume(next, output.last)) {
        output.needsReadback = true;
        output.last = await this.audio.setVolumes(id, next);
        output.needsReadback = false;
      }
      if (progress === 1) {
        output.transition = null;
        if (![...this.sessions.values()].some((session) => session.ids.includes(id)))
          this.outputs.delete(id);
      }
    }
  }

  private schedule(delay = 50) {
    const pending = [...this.outputs].some(
      ([id, output]) =>
        output.transition ||
        ![...this.sessions.values()].some((session) => session.ids.includes(id)),
    );
    if (this.timer || this.closed || !pending) return;
    // Only fades tick. Steady ducking has no polling or continuously running process.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(async () => {
        try {
          const current = await this.audio.list();
          this.retarget(current, 0);
          await this.step(current);
          this.schedule();
        } catch (error) {
          this.onError(error);
          this.schedule(1000);
        }
      });
    }, delay);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.enqueue(async () => {
      this.sessions.clear();
      if (!this.outputs.size) return;
      const current = await this.audio.list();
      this.retarget(current, 0, true);
      await this.step(current);
    });
  }
}
