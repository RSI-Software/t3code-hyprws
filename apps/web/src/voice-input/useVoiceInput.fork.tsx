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
import { useEffect, useLayoutEffect, useRef } from "react";
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
  /**
   * The active question's custom answer replaces the composer draft while it is shown.
   * `null` means a question is shown that takes no custom answer, so dictation is off.
   */
  pendingAnswer?: { key: string; text: string; commit: (text: string) => void } | null | undefined;
}

/** Adapts the upstream pending-question state to a dictation target. */
export function voicePendingAnswerFork(
  requestId: string | undefined,
  progress: {
    activeQuestion: { id: string; allowCustomAnswer?: boolean | undefined } | null;
    customAnswer: string;
  } | null,
  setAnswer: (
    questionId: string,
    text: string,
    cursor: number,
    end: number,
    mention: false,
  ) => void,
): DesktopVoiceInputFork["pendingAnswer"] {
  if (!progress) return undefined;
  const question = progress.activeQuestion;
  if (!requestId || !question || question.allowCustomAnswer === false) return null;
  return {
    key: `${requestId}:${question.id}`,
    text: progress.customAnswer,
    commit: (text) => setAnswer(question.id, text, text.length, text.length, false),
  };
}

/** Text a dictation session reads and commits once it can outlive the visible editor. */
function voiceDraftSourceFork(latest: { current: DesktopVoiceInputFork }) {
  const { draftTarget, pendingAnswer } = latest.current;
  if (!pendingAnswer) {
    return {
      read: () => readVoiceDraftTextFork(draftTarget),
      commit: (text: string) => commitVoiceDraftFork(draftTarget, text),
      subscribe: (onChange: () => void) => useComposerDraftStore.subscribe(onChange),
    };
  }
  // Answers live in React state; a transcript for an answered or changed question is dropped.
  const current = () =>
    latest.current.pendingAnswer?.key === pendingAnswer.key ? latest.current.pendingAnswer : null;
  return {
    read: () => current()?.text ?? null,
    commit: (text: string) => current()?.commit(text),
    subscribe: () => () => {},
  };
}

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useDesktopVoiceInputFork(composerInput: DesktopVoiceInputFork) {
  const input = {
    ...composerInput,
    enabled: composerInput.enabled && composerInput.pendingAnswer !== null,
  };
  const { settings } = useVoiceSettingsFork(input.environmentId);
  const { session, recorder, snapshot, waiting } = useDesktopVoiceRuntimeFork();
  const controller = session.controller;
  const canOperate = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the latest-input ref the external voice session callbacks read.
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
      text: voiceDraftSourceFork(latest).read() ?? "",
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches this composer to the external voice session as its draft owner.
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to capture-phase document `keydown` DOM events for Escape cancel.
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
  const start = () => {
    const captured = latest.current;
    if (!captured.enabled || voiceInputBlocksSubmission(controller.currentState)) return;
    const selection = captured.readSelection();
    const source = voiceDraftSourceFork(latest);
    void session.start({
      ownerKey: captured.ownerKey,
      environmentId: captured.environmentId,
      projectId: captured.projectId,
      label: captured.label,
      route:
        typeof captured.draftTarget === "string"
          ? { kind: "draft", draftId: captured.draftTarget }
          : { kind: "server", threadRef: captured.draftTarget },
      readDraft: () => {
        const text = source.read();
        return text === null ? null : { ownerKey: captured.ownerKey, text, selection };
      },
      commitDraft: (text) => source.commit(text),
      subscribe: source.subscribe,
    });
  };
  const unavailableReason =
    input.enabled && canOperate
      ? (voiceRecordingUnavailableReasonFork() ?? voiceInputUnavailableReasonFork(settings))
      : "Dictation is unavailable while this thread needs a response.";
  const busy = voiceInputBlocksSubmission(state) || textActions.busy;
  const presented = Boolean(voiceInputBlocksSubmission(state) || state.error);
  const { markDraftChanged: markTextDraftChanged } = textActions;
  const markDraftChanged = () => {
    revision.current++;
    session.markDraftChanged(input.ownerKey);
    markTextDraftChanged();
  };
  const blocksSubmission = () =>
    (session.getSnapshot().target?.ownerKey === input.ownerKey &&
      voiceInputBlocksSubmission(controller.currentState)) ||
    textBlocksSubmission();
  return {
    busy,
    preview,
    markDraftChanged,
    blocksSubmission,
    sendProps: busy
      ? { sendDisabledReason: "Finish or cancel text processing before sending." }
      : {},
    presented,
    live: settings?.live ?? false,
    toolbar: (
      <>
        <span className="sr-only" role="status">
          {preview?.text}
        </span>
        <VoiceDictationToolbarFork
          state={toolbarState}
          active={presented}
          recorder={recorder}
          waiting={waiting}
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
