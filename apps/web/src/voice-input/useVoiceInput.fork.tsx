import { readVoiceInputSettingsFork } from "@t3tools/client-runtime/rpc";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  type VoiceInputSettingsFork,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Option from "effect/Option";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { Button } from "../components/ui/button";
import { runVoiceInputRequestFork, VOICE_SETTINGS_CHANGED_FORK } from "./client.fork";
import { voiceInputUnavailableReasonFork } from "./settings.fork";
import { VoiceDictationToolbarFork } from "./VoiceComposerControls.fork";
import { useDesktopVoiceRuntimeFork } from "./VoiceInputProvider.fork";
import { commitVoiceDraftFork, readVoiceDraftTextFork } from "./draft.fork";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";

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
  draftTarget: ScopedThreadRef | DraftId;
  label: string;
  enabled: boolean;
  readSelection: () => { start: number; end: number };
  commitDraft: (text: string, cursor: number) => void;
}

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useDesktopVoiceInputFork(input: DesktopVoiceInputFork) {
  const { settings } = useVoiceSettingsFork(input.environmentId);
  const { session, recorder, snapshot } = useDesktopVoiceRuntimeFork();
  const controller = session.controller;
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const ownsSession = snapshot.target?.ownerKey === input.ownerKey;
  const state = ownsSession ? snapshot.state : IDLE;
  const toolbarState = ownsSession ? snapshot.toolbarState : IDLE;
  const preview = ownsSession ? snapshot.preview : null;
  useLayoutEffect(
    () =>
      session.attach(input.ownerKey, (text, selection) => {
        if (latest.current.enabled) latest.current.commitDraft(text, selection.end);
      }),
    [session, input.ownerKey],
  );
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        session.getSnapshot().target?.ownerKey !== latest.current.ownerKey ||
        !voiceInputBlocksSubmission(controller.currentState)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      controller.cancel();
    };
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("keydown", cancel, true);
    };
  }, [controller, session]);
  const start = useCallback(() => {
    const captured = latest.current;
    if (!captured.enabled || voiceInputBlocksSubmission(controller.currentState)) return;
    const selection = captured.readSelection();
    void session.start({
      ownerKey: captured.ownerKey,
      environmentId: captured.environmentId,
      label: captured.label,
      route:
        typeof captured.draftTarget === "string"
          ? { kind: "draft", draftId: captured.draftTarget }
          : { kind: "server", threadRef: captured.draftTarget },
      readDraft: () => {
        const text = readVoiceDraftTextFork(captured.draftTarget);
        return text === null ? null : { ownerKey: captured.ownerKey, text, selection };
      },
      commitDraft: (text) => commitVoiceDraftFork(captured.draftTarget, text),
      subscribe: (onChange) => useComposerDraftStore.subscribe(onChange),
    });
  }, [controller, session]);
  const unavailableReason = input.enabled
    ? voiceInputUnavailableReasonFork(settings)
    : "Dictation is unavailable while this thread needs a response.";
  const busy = voiceInputBlocksSubmission(state);
  const presented = Boolean(window.desktopBridge && (busy || state.error));
  const markDraftChanged = useCallback(() => {
    session.markDraftChanged(input.ownerKey);
  }, [session, input.ownerKey]);
  const blocksSubmission = useCallback(
    () =>
      session.getSnapshot().target?.ownerKey === input.ownerKey &&
      voiceInputBlocksSubmission(controller.currentState),
    [controller, session, input.ownerKey],
  );
  return {
    busy,
    preview,
    markDraftChanged,
    blocksSubmission,
    sendProps: busy ? { sendDisabledReason: "Finish or cancel dictation before sending." } : {},
    presented,
    live: settings?.provider === "meta",
    toolbar: window.desktopBridge ? (
      <>
        <span className="sr-only" role="status">
          {preview?.text}
        </span>
        <VoiceDictationToolbarFork
          state={toolbarState}
          active={presented}
          recorder={recorder}
          onCancel={() => controller.cancel()}
          onFinish={() => void controller.stop()}
          onStart={start}
        />
      </>
    ) : null,
    controls: window.desktopBridge ? (
      <div className="flex items-center gap-1" role="group" aria-label="Dictation">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Record dictation"
          title={
            voiceInputBlocksSubmission(snapshot.state) && !ownsSession
              ? "Dictation is finishing in another thread."
              : (unavailableReason ?? "Record dictation")
          }
          disabled={voiceInputBlocksSubmission(snapshot.state) || unavailableReason !== null}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!voiceInputBlocksSubmission(controller.currentState) && !unavailableReason) start();
          }}
        >
          <MicIcon />
        </Button>
      </div>
    ) : null,
  };
}
