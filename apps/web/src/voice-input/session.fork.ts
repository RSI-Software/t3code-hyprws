import {
  VoiceInputController,
  resolveTranscriptCommit,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ThreadRouteTarget } from "../threadRoutes";
import type { VoicePreviewFork } from "./preview.fork";

export interface DesktopVoiceTargetFork {
  readonly ownerKey: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly route: ThreadRouteTarget;
  readonly readDraft: () => Omit<VoiceDraftSnapshot, "revision"> | null;
  readonly commitDraft: VoiceInputControllerDependencies["commitDraft"];
  readonly subscribe: (onChange: () => void) => () => void;
}

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export interface DesktopVoiceSnapshotFork {
  readonly state: VoiceInputState;
  readonly toolbarState: VoiceInputState;
  readonly target: DesktopVoiceTargetFork | null;
  readonly visibleOwner: string | null;
  readonly transcript: string | null;
  readonly preview: VoicePreviewFork | null;
}

interface VoiceTextCallbacksFork {
  readonly processTranscript: (
    text: string,
    signal: AbortSignal,
    draft?: VoiceDraftSnapshot,
  ) => Promise<string>;
  readonly transcriptionCommitted: (text: string) => void;
}

/** Like mobile's global session, bind the controller to a draft rather than a mounted editor. */
export class DesktopVoiceSessionFork {
  readonly controller: VoiceInputController;
  private snapshot: DesktopVoiceSnapshotFork = {
    state: IDLE,
    toolbarState: IDLE,
    target: null,
    visibleOwner: null,
    transcript: null,
    preview: null,
  };
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private unsubscribeDraft: (() => void) | null = null;
  private editorCommit: VoiceInputControllerDependencies["commitDraft"] | null = null;
  private editorText: VoiceTextCallbacksFork | null = null;

  constructor(
    dependencies: Omit<
      VoiceInputControllerDependencies,
      "readDraft" | "commitDraft" | "getTranscriber" | "onStateChange"
    > & {
      readonly getTranscriber: (target: DesktopVoiceTargetFork) => VoiceTranscriber;
    },
  ) {
    this.controller = new VoiceInputController({
      ...dependencies,
      readDraft: () => {
        const draft = this.snapshot.target?.readDraft();
        return draft ? { ...draft, revision: this.revision } : null;
      },
      commitDraft: (text, selection) => {
        const target = this.snapshot.target;
        if (!target) return;
        target.commitDraft(text, selection);
        if (this.snapshot.visibleOwner === target.ownerKey) {
          this.editorCommit?.(text, selection);
          this.editorText?.transcriptionCommitted(text);
        }
      },
      getTranscriber: () => {
        const target = this.snapshot.target;
        if (!target) return null;
        const transcriber = dependencies.getTranscriber(target);
        return {
          prepare: async (options) => {
            const prepared = await transcriber.prepare(options);
            return {
              ...prepared,
              transcribe: async (uri, transcriptionOptions) => {
                const transcript = await prepared.transcribe(uri, transcriptionOptions);
                if (!transcriptionOptions.signal.aborted) this.update({ transcript });
                if (
                  !transcriptionOptions.signal.aborted &&
                  this.snapshot.visibleOwner === target.ownerKey &&
                  this.editorText
                )
                  return this.editorText.processTranscript(
                    transcript,
                    transcriptionOptions.signal,
                    this.capturedDraft ?? undefined,
                  );
                return transcript;
              },
            };
          },
        };
      },
      onStateChange: (state) => {
        if (state.phase === "recording") {
          const draft = this.snapshot.target?.readDraft();
          this.capturedDraft = draft ? { ...draft, revision: this.revision } : null;
        }
        if (!voiceInputBlocksSubmission(state)) {
          this.unsubscribeDraft?.();
          this.unsubscribeDraft = null;
        }
        this.update({
          state,
          ...(state.phase === "idle" || state.phase === "error" ? { preview: null } : {}),
          ...(state.phase === "idle" ? { transcript: null } : { toolbarState: state }),
        });
      },
    });
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  attach(
    ownerKey: string,
    commit: VoiceInputControllerDependencies["commitDraft"],
    text?: VoiceTextCallbacksFork,
  ) {
    this.editorCommit = commit;
    this.editorText = text ?? null;
    this.update({ visibleOwner: ownerKey });
    return () => {
      if (this.snapshot.visibleOwner !== ownerKey) return;
      this.editorCommit = null;
      this.editorText = null;
      this.update({ visibleOwner: null });
      // Only completed audio may keep running off screen. Never leave an unseen microphone live.
      if (
        this.snapshot.target?.ownerKey === ownerKey &&
        (this.snapshot.state.phase === "preparing" || this.snapshot.state.phase === "recording")
      )
        this.controller.cancel();
    };
  }

  start(target: DesktopVoiceTargetFork) {
    if (voiceInputBlocksSubmission(this.snapshot.state)) return Promise.resolve();
    this.unsubscribeDraft?.();
    this.revision = 0;
    this.capturedDraft = null;
    this.update({ target, transcript: null, preview: null });
    let previous = target.readDraft()?.text;
    this.unsubscribeDraft = target.subscribe(() => {
      const text = target.readDraft()?.text;
      if (text !== previous) {
        previous = text;
        this.revision++;
        this.update({ preview: null });
      }
    });
    return this.controller.start();
  }

  markDraftChanged(ownerKey: string) {
    if (this.snapshot.target?.ownerKey === ownerKey) {
      this.revision++;
      this.update({ preview: null });
    }
  }

  /** View-only words share the captured draft and conflict checks of the final commit. */
  previewTranscript(text: string, locale: string) {
    const captured = this.capturedDraft;
    const draft = this.snapshot.target?.readDraft();
    if (!captured || !draft || !voiceInputBlocksSubmission(this.snapshot.state)) return;
    const result = resolveTranscriptCommit(
      captured,
      { ...draft, revision: this.revision },
      text,
      locale,
    );
    this.update({
      preview:
        result.kind === "commit"
          ? {
              draft: captured,
              text: result.text.slice(captured.selection.start, result.selection.end),
            }
          : null,
    });
  }

  dispose() {
    this.controller.dispose();
    this.unsubscribeDraft?.();
    this.unsubscribeDraft = null;
  }

  private update(patch: Partial<DesktopVoiceSnapshotFork>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
