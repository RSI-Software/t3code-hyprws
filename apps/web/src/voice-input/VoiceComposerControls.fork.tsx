import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import type { DesktopVoiceRecorderFork } from "./recorder.fork";
import "./voiceComposer.fork.css";

/** Desktop counterpart of mobile's ComposerDictationStatus. */
function RecordingWaveformFork({
  recorder,
  recording,
}: {
  recorder: DesktopVoiceRecorderFork;
  recording: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = useState(64);
  const [meter, setMeter] = useState({ levels: Array<number>(64).fill(0), seconds: 0 });
  useEffect(() => {
    if (!recording) return;
    const started = performance.now();
    let firstSample = true;
    const timer = window.setInterval(() => {
      const reset = firstSample;
      firstSample = false;
      setMeter((previous) => ({
        levels: [
          ...(reset ? Array<number>(63).fill(0) : previous.levels.slice(1)),
          recorder.readLevel(),
        ],
        seconds: Math.floor((performance.now() - started) / 1000),
      }));
    }, 100);
    return () => window.clearInterval(timer);
  }, [recorder, recording]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBarCount(Math.max(1, Math.min(64, Math.floor(entry.contentRect.width / 5))));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const elapsed = `${Math.floor(meter.seconds / 60)}:${String(meter.seconds % 60).padStart(2, "0")}`;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" aria-label={`Recording ${elapsed}`}>
      <div
        ref={host}
        className="flex h-8 min-w-0 flex-1 items-center justify-between overflow-hidden"
        aria-hidden="true"
      >
        {meter.levels.slice(-barCount).map((level, index) => (
          <span
            key={index}
            data-voice-waveform-bar-fork="true"
            className="h-8 w-0.5 shrink-0 rounded-full bg-foreground"
            style={{
              transform: `scaleY(${(2 + level * 30) / 32})`,
              opacity: 0.22 + level * 0.78,
            }}
          />
        ))}
      </div>
      <span
        className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        {elapsed}
      </span>
    </div>
  );
}

/** Mobile's cancel/status/confirm row, using the desktop composer's action style. */
export function VoiceDictationToolbarFork({
  state,
  active,
  recorder,
  onCancel,
  onFinish,
  onStart,
}: {
  state: VoiceInputState;
  active: boolean;
  recorder: DesktopVoiceRecorderFork;
  onCancel: () => void;
  onFinish: () => void;
  onStart: () => void;
}) {
  const recording = state.phase === "recording";
  const error = state.phase === "error";
  const status = state.phase === "preparing" ? "Preparing" : "Transcribing";
  return (
    <div
      className="flex h-8 w-full min-w-0 items-center gap-3"
      role="group"
      aria-label="Dictation controls"
    >
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={error ? "Dismiss dictation error" : "Cancel dictation"}
        title={error ? "Dismiss" : "Cancel dictation (Escape)"}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onCancel}
      >
        <XIcon />
      </Button>
      <div className="relative h-8 min-w-0 flex-1" data-voice-recording-fork={recording}>
        <div
          data-voice-waveform-face-fork="true"
          className="absolute inset-0 flex"
          aria-hidden={!recording}
        >
          <RecordingWaveformFork recorder={recorder} recording={recording && active} />
        </div>
        <span
          data-voice-status-face-fork="true"
          className={`absolute inset-0 flex items-center justify-center text-center text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
          aria-hidden={recording}
          role={error ? "alert" : "status"}
        >
          {error ? state.error : status}
        </span>
      </div>
      <button
        type="button"
        className="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-64"
        data-voice-recording-fork={recording || error}
        aria-label={recording ? "Finish dictation" : error ? "Retry dictation" : status}
        disabled={!recording && !error}
        onPointerDown={(event) => event.preventDefault()}
        onClick={error ? onStart : onFinish}
      >
        <span
          data-voice-waveform-face-fork="true"
          className="absolute inset-0 flex items-center justify-center"
          aria-hidden="true"
        >
          {error ? <MicIcon className="size-4" /> : <CheckIcon className="size-4" />}
        </span>
        <span
          data-voice-status-face-fork="true"
          className="absolute inset-0 flex items-center justify-center"
          aria-hidden="true"
        >
          {active && !recording && !error ? <Spinner size="md" /> : null}
        </span>
      </button>
    </div>
  );
}

/** Preserve the draft editor and replace its toolbar in compact and expanded layouts. */
export function VoiceComposerFooterFork({
  toolbar,
  compact,
  presented,
}: {
  toolbar: ReactNode;
  compact: boolean;
  presented: boolean;
}) {
  if (!toolbar) return null;
  return (
    <div
      data-voice-input-toolbar-fork="true"
      inert={!presented ? true : undefined}
      aria-hidden={!presented}
      className={
        compact
          ? "absolute inset-x-px bottom-px z-10 flex h-12 items-center px-3"
          : "absolute inset-x-0 bottom-0 flex min-w-0 items-center px-3 pb-3 sm:px-4 sm:pb-4"
      }
    >
      {toolbar}
    </div>
  );
}
