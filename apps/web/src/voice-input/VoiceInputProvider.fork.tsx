import { readVoiceInputSettingsFork, transcribeVoiceInputFork } from "@t3tools/client-runtime/rpc";
import { voiceInputBlocksSubmission } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { MicIcon, XIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { readPreparedConnection } from "../state/session";
import { runVoiceInputRequestFork } from "./client.fork";
import { DesktopVoiceRecorderFork } from "./recorder.fork";
import { DesktopVoiceSessionFork } from "./session.fork";
import { voiceInputUnavailableReasonFork } from "./settings.fork";
import { prepareLiveVoiceFork } from "./realtime.fork";

function createDesktopVoiceRuntimeFork() {
  // Whether the live speech service is still starting, e.g. loading a cold model.
  let waiting = false;
  const listeners = new Set<() => void>();
  const serviceWaiting = {
    read: () => waiting,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const setWaiting = (next: boolean) => {
    if (next === waiting) return;
    waiting = next;
    for (const listener of listeners) listener();
  };
  const recorder = new DesktopVoiceRecorderFork((status) => {
    void session.controller.handleRecorderStatus(status);
  });
  const session = new DesktopVoiceSessionFork({
    recorder,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => recorder.release(),
    deleteRecording: (uri) => recorder.delete(uri),
    getTranscriber: (target) => ({
      prepare: async ({ signal }) => {
        recorder.useLiveSession(null);
        const prepared = readPreparedConnection(target.environmentId);
        if (!prepared) throw new Error("Environment is disconnected.");
        const config = await runVoiceInputRequestFork(readVoiceInputSettingsFork(prepared), signal);
        const unavailableReason = voiceInputUnavailableReasonFork(config);
        if (unavailableReason) throw new Error(unavailableReason);
        // A failed live preview never costs the recording: Stop uploads the captured WAV instead.
        const live = config.live
          ? await prepareLiveVoiceFork(prepared, signal, {
              onPreview: (text) => {
                if (!signal.aborted) session.previewTranscript(text, navigator.language);
              },
              onWaiting: setWaiting,
            }).catch((error: unknown) => {
              if (signal.aborted) throw error;
              return null;
            })
          : null;
        recorder.useLiveSession(live);
        return {
          locale: navigator.language,
          transcribe: async (uri, { signal }) => {
            if (live) {
              const text = await live.result.catch(() => null);
              if (text !== null) return text;
            }
            signal.throwIfAborted();
            return (
              await runVoiceInputRequestFork(
                transcribeVoiceInputFork(prepared, recorder.read(uri)),
                signal,
              )
            ).text;
          },
        };
      },
    }),
  });
  return { session, recorder, serviceWaiting };
}

const DesktopVoiceContextFork = createContext<ReturnType<
  typeof createDesktopVoiceRuntimeFork
> | null>(null);

/** Window-owned lifetime: navigating among threads or settings does not dispose transcription. */
export function DesktopVoiceInputProviderFork({ children }: { children: ReactNode }) {
  const [runtime] = useState(createDesktopVoiceRuntimeFork);
  useEffect(() => {
    const interrupt = () => {
      if (document.hidden) void runtime.session.controller.appMovedToBackground();
    };
    document.addEventListener("visibilitychange", interrupt);
    return () => {
      document.removeEventListener("visibilitychange", interrupt);
      runtime.session.dispose();
      runtime.recorder.release();
    };
  }, [runtime]);
  return (
    <DesktopVoiceContextFork value={runtime}>
      {children}
      <BackgroundVoiceControlFork />
    </DesktopVoiceContextFork>
  );
}

export function useDesktopVoiceRuntimeFork() {
  const runtime = useContext(DesktopVoiceContextFork);
  if (!runtime) throw new Error("Desktop dictation requires its window provider.");
  const snapshot = useSyncExternalStore(runtime.session.subscribe, runtime.session.getSnapshot);
  const waiting = useSyncExternalStore(
    runtime.serviceWaiting.subscribe,
    runtime.serviceWaiting.read,
  );
  return { ...runtime, snapshot, waiting };
}

function BackgroundVoiceControlFork() {
  const { session, snapshot, waiting } = useDesktopVoiceRuntimeFork();
  const { target, state, transcript, visibleOwner } = snapshot;
  const navigate = useNavigate();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "dictation-transcript" });
  const busy = voiceInputBlocksSubmission(state);
  const offscreen = target && target.ownerKey !== visibleOwner;
  const recoverable = Boolean(transcript && state.error);
  const backgroundActive = offscreen && (busy || state.error);
  if (!target) return null;
  if (!recoverable && !backgroundActive) return null;

  const returnToDraft = () => {
    const route = target.route;
    if (route.kind === "draft") {
      void navigate({ to: "/draft/$draftId", params: { draftId: route.draftId } });
    } else {
      void navigate({ to: "/$environmentId/$threadId", params: route.threadRef });
    }
  };
  return (
    <aside
      aria-label="Background dictation"
      className="fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md"
    >
      <div className="shrink-0">
        <MicIcon className="size-4" />
      </div>
      <div className="min-w-0 max-w-64">
        <p className="truncate text-xs font-medium">{target.label}</p>
        <p
          className={`text-xs ${state.error ? "text-destructive" : "text-muted-foreground"}`}
          role={state.error ? "alert" : "status"}
        >
          {state.error ?? (waiting ? "Waiting for speech service…" : "Transcribing…")}
        </p>
      </div>
      {offscreen ? (
        <Button size="sm" variant="ghost" onClick={returnToDraft}>
          Return
        </Button>
      ) : null}
      {transcript ? (
        <Button size="sm" variant="ghost" onClick={() => copyToClipboard(transcript)}>
          {isCopied ? "Copied" : "Copy transcript"}
        </Button>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={busy ? "Cancel background dictation" : "Dismiss dictation error"}
        onClick={() => session.controller.cancel()}
      >
        <XIcon />
      </Button>
    </aside>
  );
}
