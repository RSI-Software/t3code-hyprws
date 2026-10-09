import { transformVoiceTextFork } from "@t3tools/client-runtime/rpc";
import {
  resolveTranscriptCommit,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CaseSensitiveIcon, ListIcon, Undo2Icon, XIcon } from "lucide-react";
import { readPreparedConnection, useEnvironmentScope } from "../state/session";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { useVoiceTextSettingsFork } from "./useVoiceSettings.fork";
import { runVoiceInputRequestFork } from "./client.fork";
import {
  autoVoiceFormattingFork,
  sameVoiceTextDraftFork,
  voiceTextReplacementFork,
} from "./voiceTextDraft.fork";

export interface VoiceTextInputFork {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  threadId: ThreadId | null;
  ownerKey: string;
  enabled: boolean;
  readDraft: () => VoiceDraftSnapshot;
  commitDraft: (text: string, cursor: number) => void;
}

export function useVoiceTextFork(input: VoiceTextInputFork) {
  const canOperate = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const { settings } = useVoiceTextSettingsFork(input.environmentId);
  const config = input.projectId
    ? (settings?.projects[input.projectId] ?? settings?.defaults)
    : null;
  const latest = useRef({ input, config, canOperate });
  useLayoutEffect(() => {
    latest.current = { input, config, canOperate };
  });
  const pending = useRef<AbortController | null>(null);
  const rawDraft = useRef<{ text: string; cursor: number; ownerKey: string } | null>(null);
  const undoRef = useRef<{
    before: string;
    cursor: number;
    after: string;
    ownerKey: string;
  } | null>(null);
  const skipAutomatic = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [phase, setPhase] = useState<"cleanup" | "format" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = JSON.stringify([input.environmentId, input.projectId, input.ownerKey]);
  const [stateScope, setStateScope] = useState(scopeKey);
  if (stateScope !== scopeKey) {
    setStateScope(scopeKey);
    setCanUndo(false);
    setPhase(null);
    setError(null);
  }
  const requestScope = useRef(scopeKey);
  const cancel = useCallback(() => {
    skipAutomatic.current = true;
    pending.current?.abort();
    pending.current = null;
    setPhase(null);
  }, []);
  useEffect(() => {
    requestScope.current = scopeKey;
    skipAutomatic.current = true;
    pending.current?.abort();
    pending.current = null;
    rawDraft.current = null;
    undoRef.current = null;
    return () => pending.current?.abort();
  }, [scopeKey]);

  const requestText = useCallback(
    async (operation: "cleanup" | "format", text: string, signal: AbortSignal) => {
      const current = latest.current.input;
      const prepared = readPreparedConnection(current.environmentId);
      if (!prepared || !current.projectId) throw new Error("Environment is disconnected.");
      return (
        await runVoiceInputRequestFork(
          transformVoiceTextFork(prepared, {
            operation,
            text,
            projectId: current.projectId,
            ...(current.threadId ? { threadId: current.threadId } : {}),
          }),
          signal,
          "Text processing failed. Check the selected provider and model.",
        )
      ).text;
    },
    [],
  );
  const rememberUndo = useCallback(
    (before: string, cursor: number, after: string, ownerKey: string) => {
      if (before === after) return;
      undoRef.current = { before, cursor, after, ownerKey };
      setCanUndo(true);
    },
    [],
  );
  const run = useCallback(
    async (operation: "cleanup" | "format", automatic = false) => {
      const current = latest.current;
      if (
        !current.canOperate ||
        (!current.input.enabled && !automatic) ||
        !current.config ||
        pending.current
      )
        return;
      if (
        (operation === "cleanup" ? current.config.cleanupMode : current.config.formattingMode) ===
        "off"
      )
        return;
      const captured = current.input.readDraft();
      const capturedScope = requestScope.current;
      const range =
        operation === "cleanup" && captured.selection.start !== captured.selection.end
          ? captured.text.slice(captured.selection.start, captured.selection.end)
          : captured.text;
      if (!range.trim()) return;
      const controller = new AbortController();
      pending.current = controller;
      setPhase(operation);
      if (!automatic) setError(null);
      await requestText(operation, range, controller.signal)
        .then((result) => {
          if (controller.signal.aborted || capturedScope !== requestScope.current) return;
          if (!sameVoiceTextDraftFork(captured, latest.current.input.readDraft())) {
            setError("The draft changed. The generated text was not applied.");
            return;
          }
          const replacement = voiceTextReplacementFork(captured, operation, result);
          const previousUndo = automatic ? undoRef.current : null;
          latest.current.input.commitDraft(replacement.text, replacement.cursor);
          rememberUndo(
            previousUndo?.after === captured.text ? previousUndo.before : captured.text,
            previousUndo?.after === captured.text ? previousUndo.cursor : captured.selection.end,
            replacement.text,
            captured.ownerKey,
          );
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              "Text processing failed. Your draft was preserved. Retry the action or check the model in Settings.",
            );
        })
        .finally(() => {
          if (pending.current === controller) {
            pending.current = null;
            setPhase(null);
          }
        });
    },
    [rememberUndo, requestText],
  );

  const processTranscript = useCallback(
    async (text: string, signal: AbortSignal, originalDraft?: VoiceDraftSnapshot) => {
      skipAutomatic.current = false;
      const current = latest.current;
      // The controller validates the final commit with its own revision counter.
      const captured = originalDraft ?? current.input.readDraft();
      const raw = resolveTranscriptCommit(captured, captured, text, navigator.language);
      rawDraft.current =
        raw.kind === "commit"
          ? { text: raw.text, cursor: raw.selection.end, ownerKey: captured.ownerKey }
          : null;
      if (!current.canOperate || !text.trim() || current.config?.cleanupMode !== "auto")
        return text;
      const controller = new AbortController();
      pending.current = controller;
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      setPhase("cleanup");
      setError(null);
      return requestText("cleanup", text, controller.signal)
        .catch((cause) => {
          if (signal.aborted) throw cause;
          if (controller.signal.aborted) return text;
          setError("Automatic cleanup failed. The original transcript was preserved.");
          return text;
        })
        .finally(() => {
          signal.removeEventListener("abort", abort);
          if (pending.current === controller) {
            pending.current = null;
            setPhase(null);
          }
        });
    },
    [requestText],
  );
  const transcriptionCommitted = useCallback(
    (text: string) => {
      const current = latest.current;
      const raw = rawDraft.current;
      rawDraft.current = null;
      if (raw?.ownerKey === current.input.ownerKey)
        rememberUndo(raw.text, raw.cursor, text, raw.ownerKey);
      if (!skipAutomatic.current && current.config && autoVoiceFormattingFork(current.config, text))
        void run("format", true);
    },
    [rememberUndo, run],
  );
  const markDraftChanged = useCallback(() => {
    undoRef.current = null;
    setCanUndo(false);
  }, []);
  const undo = () => {
    const previous = undoRef.current;
    const current = latest.current.input;
    if (
      !previous ||
      previous.ownerKey !== current.ownerKey ||
      previous.after !== current.readDraft().text
    ) {
      markDraftChanged();
      return;
    }
    current.commitDraft(previous.before, previous.cursor);
    markDraftChanged();
    setError(null);
  };
  const controls =
    config && input.projectId ? (
      <div className="flex items-center gap-1" role="group" aria-label="Text processing">
        {phase ? (
          <>
            <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
              <Spinner size="sm" />
              {phase === "cleanup" ? "Cleaning up" : "Formatting"}
            </span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Cancel text processing"
              title="Cancel text processing"
              onClick={cancel}
            >
              <XIcon />
            </Button>
          </>
        ) : (
          <>
            {config.cleanupMode !== "off" ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Clean up draft"
                title="Clean up selected text or draft"
                disabled={!input.enabled || !canOperate}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void run("cleanup")}
              >
                <CaseSensitiveIcon />
              </Button>
            ) : null}
            {config.formattingMode !== "off" ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Format draft"
                title="Format draft"
                disabled={!input.enabled || !canOperate}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void run("format")}
              >
                <ListIcon />
              </Button>
            ) : null}
            {canUndo ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Undo text processing"
                title="Undo text processing"
                disabled={!input.enabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={undo}
              >
                <Undo2Icon />
              </Button>
            ) : null}
          </>
        )}
        {error ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="max-w-48 truncate text-xs text-destructive"
                  onClick={() => setError(null)}
                  aria-label={`Dismiss: ${error}`}
                >
                  {error}
                </button>
              }
            />
            <TooltipPopup>{error}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    ) : null;
  const blocksSubmission = useCallback(() => pending.current !== null, []);
  return {
    processTranscript,
    transcriptionCommitted,
    markDraftChanged,
    busy: phase !== null,
    phase,
    cancel,
    blocksSubmission,
    controls,
  };
}
