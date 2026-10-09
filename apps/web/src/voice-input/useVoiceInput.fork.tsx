/// <reference lib="es2024.promise" />
import { readVoiceInputSettingsFork, transcribeVoiceInputFork } from "@t3tools/client-runtime/rpc";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceInputState,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input";
import {
  type EnvironmentId,
  type VoiceInputSettingsFork,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import * as Option from "effect/Option";
import {
  useEnvironmentScope,
  usePreparedConnection,
  readPreparedConnection,
} from "../state/session";
import { Button } from "../components/ui/button";
import { runVoiceInputRequestFork, VOICE_SETTINGS_CHANGED_FORK } from "./client.fork";
import { DesktopVoiceRecorderFork, recordingToWavFork } from "./recorder.fork";
import { voiceInputUnavailableReasonFork } from "./settings.fork";
import { VoiceDictationToolbarFork } from "./VoiceComposerControls.fork";

export function useVoiceSettingsFork(environmentId: EnvironmentId | null) {
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = Option.getOrNull(preparedOption);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const [result, setResult] = useState<{
    environmentId: EnvironmentId;
    settings: VoiceInputSettingsFork;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!window.desktopBridge || !prepared || !canRead) return;
    let active = true;
    let request: AbortController | null = null;
    const load = () => {
      request?.abort();
      const current = new AbortController();
      request = current;
      void runVoiceInputRequestFork(readVoiceInputSettingsFork(prepared), current.signal).then(
        (settings) => {
          if (active && !current.signal.aborted) {
            setResult({ environmentId: prepared.environmentId, settings });
            setError(null);
          }
        },
        () => {
          if (active && !current.signal.aborted) setError("Could not load dictation settings.");
        },
      );
    };
    load();
    window.addEventListener(VOICE_SETTINGS_CHANGED_FORK, load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      request?.abort();
      window.removeEventListener(VOICE_SETTINGS_CHANGED_FORK, load);
      window.removeEventListener("focus", load);
    };
  }, [prepared, canRead]);
  return { settings: result?.environmentId === environmentId ? result.settings : null, error };
}

interface DesktopVoiceInputFork {
  environmentId: EnvironmentId;
  ownerKey: string;
  enabled: boolean;
  readDraft: () => Omit<VoiceDraftSnapshot, "revision">;
  commitDraft: (text: string, cursor: number) => void;
}

function createVoiceControllerFork(
  latest: RefObject<DesktopVoiceInputFork>,
  revision: RefObject<number>,
  onStateChange: (state: VoiceInputState) => void,
) {
  const recorder = new DesktopVoiceRecorderFork((status) => {
    void controller.handleRecorderStatus(status);
  });
  const controller = new VoiceInputController({
    recorder,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => recorder.release(),
    deleteRecording: (uri) => recorder.delete(uri),
    readDraft: () =>
      latest.current.enabled ? { ...latest.current.readDraft(), revision: revision.current } : null,
    commitDraft: (text, selection) => latest.current.commitDraft(text, selection.end),
    onStateChange,
    getTranscriber: () => ({
      prepare: async ({ signal }) => {
        const prepared = readPreparedConnection(latest.current.environmentId);
        if (!prepared) throw new Error("Environment is disconnected.");
        const config = await runVoiceInputRequestFork(readVoiceInputSettingsFork(prepared), signal);
        const unavailableReason = voiceInputUnavailableReasonFork(config);
        if (unavailableReason) throw new Error(unavailableReason);
        return {
          locale: navigator.language,
          transcribe: async (uri, { signal }) => {
            const wav = await recordingToWavFork(recorder.read(uri), signal);
            return (await runVoiceInputRequestFork(transcribeVoiceInputFork(prepared, wav), signal))
              .text;
          },
        };
      },
    }),
  });
  return { controller, recorder };
}

export function useDesktopVoiceInputFork(input: DesktopVoiceInputFork) {
  const { settings } = useVoiceSettingsFork(input.environmentId);
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const revision = useRef(0);
  const [{ state, toolbarState }, setState] = useState(() => {
    const idle: VoiceInputState = { phase: "idle", error: null, errorAction: null };
    return { state: idle, toolbarState: idle };
  });
  // Construction stores callbacks; only recorder events read the refs.
  // react-doctor-disable-next-line react-hooks-js/refs
  const [{ controller, recorder }] = useState(() =>
    createVoiceControllerFork(latest, revision, (next) =>
      setState((previous) => ({
        state: next,
        toolbarState: next.phase === "idle" ? previous.toolbarState : next,
      })),
    ),
  );
  useEffect(() => {
    controller.ownerChanged();
  }, [controller, input.ownerKey, input.environmentId]);
  useEffect(() => {
    const interrupt = () => {
      if (document.hidden) void controller.appMovedToBackground();
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !voiceInputBlocksSubmission(controller.currentState)) return;
      event.preventDefault();
      event.stopPropagation();
      controller.cancel();
    };
    document.addEventListener("visibilitychange", interrupt);
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("visibilitychange", interrupt);
      document.removeEventListener("keydown", cancel, true);
      controller.dispose();
    };
  }, [controller]);
  const unavailableReason = input.enabled
    ? voiceInputUnavailableReasonFork(settings)
    : "Dictation is unavailable while this thread needs a response.";
  const busy = voiceInputBlocksSubmission(state);
  const presented = Boolean(window.desktopBridge && (busy || state.error));
  const markDraftChanged = useCallback(() => {
    revision.current++;
  }, []);
  const blocksSubmission = useCallback(
    () => voiceInputBlocksSubmission(controller.currentState),
    [controller],
  );
  return {
    busy,
    markDraftChanged,
    blocksSubmission,
    sendProps: busy ? { sendDisabledReason: "Finish or cancel dictation before sending." } : {},
    presented,
    toolbar: window.desktopBridge ? (
      <VoiceDictationToolbarFork
        state={toolbarState}
        active={presented}
        recorder={recorder}
        onCancel={() => controller.cancel()}
        onFinish={() => void controller.stop()}
        onStart={() => void controller.start()}
      />
    ) : null,
    controls: window.desktopBridge ? (
      <div className="flex items-center gap-1" role="group" aria-label="Dictation">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Record dictation"
          title={unavailableReason ?? "Record dictation"}
          disabled={busy || unavailableReason !== null}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!voiceInputBlocksSubmission(controller.currentState) && !unavailableReason)
              void controller.start();
          }}
        >
          <MicIcon />
        </Button>
      </div>
    ) : null,
  };
}
