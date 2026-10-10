import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  type ProjectId,
  type ThreadId,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useEnvironmentScope } from "../state/session";
import { Button } from "../components/ui/button";
import { useVoiceSettingsFork } from "./useVoiceSettings.fork";
import { voiceInputUnavailableReasonFork } from "./settings.fork";
import { VoiceDictationToolbarFork } from "./VoiceComposerControls.fork";
import { useDesktopVoiceRuntimeFork } from "./VoiceInputProvider.fork";
import { commitVoiceDraftFork, readVoiceDraftTextFork } from "./draft.fork";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useVoiceTextFork } from "./useVoiceText.fork";
import { voiceRecordingUnavailableReasonFork } from "./settings.fork";

interface DesktopVoiceInputFork {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  threadId: ThreadId | null;
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
  const canOperate = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const ownsSession = snapshot.target?.ownerKey === input.ownerKey;
  const state = ownsSession ? snapshot.state : IDLE;
  const toolbarState = ownsSession ? snapshot.toolbarState : IDLE;
  const preview = ownsSession ? snapshot.preview : null;
  const revision = useRef(0);
  const textActions = useVoiceTextFork({
    ...input,
    enabled: input.enabled && !voiceInputBlocksSubmission(state),
    readDraft: (): VoiceDraftSnapshot => ({
      ownerKey: input.ownerKey,
      text: readVoiceDraftTextFork(input.draftTarget) ?? "",
      selection: input.readSelection(),
      revision: revision.current,
    }),
  });
  const {
    processTranscript,
    transcriptionCommitted,
    cancel: cancelText,
    blocksSubmission: textBlocksSubmission,
  } = textActions;
  useLayoutEffect(
    () =>
      session.attach(
        input.ownerKey,
        (text, selection) => {
          if (latest.current.enabled) latest.current.commitDraft(text, selection.end);
        },
        { processTranscript, transcriptionCommitted },
      ),
    [session, input.ownerKey, processTranscript, transcriptionCommitted],
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
      if (textBlocksSubmission()) cancelText();
      else controller.cancel();
    };
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("keydown", cancel, true);
    };
  }, [controller, session, cancelText, textBlocksSubmission]);
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
  const unavailableReason =
    input.enabled && canOperate
      ? (voiceRecordingUnavailableReasonFork() ?? voiceInputUnavailableReasonFork(settings))
      : "Dictation is unavailable while this thread needs a response.";
  const busy = voiceInputBlocksSubmission(state) || textActions.busy;
  const presented = Boolean(voiceInputBlocksSubmission(state) || state.error);
  const { markDraftChanged: markTextDraftChanged } = textActions;
  const markDraftChanged = useCallback(() => {
    revision.current++;
    session.markDraftChanged(input.ownerKey);
    markTextDraftChanged();
  }, [session, input.ownerKey, markTextDraftChanged]);
  const blocksSubmission = useCallback(
    () =>
      (session.getSnapshot().target?.ownerKey === input.ownerKey &&
        voiceInputBlocksSubmission(controller.currentState)) ||
      textBlocksSubmission(),
    [controller, session, input.ownerKey, textBlocksSubmission],
  );
  return {
    busy,
    preview,
    markDraftChanged,
    blocksSubmission,
    sendProps: busy
      ? { sendDisabledReason: "Finish or cancel text processing before sending." }
      : {},
    presented,
    live: settings?.provider === "meta",
    toolbar: (
      <>
        <span className="sr-only" role="status">
          {preview?.text}
        </span>
        <VoiceDictationToolbarFork
          state={toolbarState}
          active={presented}
          recorder={recorder}
          processingPhase={textActions.phase}
          onCancel={() => (textBlocksSubmission() ? cancelText() : controller.cancel())}
          onFinish={() => void controller.stop()}
          onStart={start}
        />
      </>
    ),
    controls: (
      <>
        {textActions.controls}
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
            disabled={
              busy || voiceInputBlocksSubmission(snapshot.state) || unavailableReason !== null
            }
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!voiceInputBlocksSubmission(controller.currentState) && !unavailableReason)
                start();
            }}
          >
            <MicIcon />
          </Button>
        </div>
      </>
    ),
  };
}
