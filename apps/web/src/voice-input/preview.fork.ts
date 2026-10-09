import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { VoiceDraftSnapshot } from "@t3tools/client-runtime/voice-input";
import { useLayoutEffect } from "react";
import { collapseExpandedComposerCursor } from "../composer-logic";
import { collapsedToFlat, flatToPm, serializeEditorDoc } from "../composer-rich-text-doc";

export interface VoicePreviewFork {
  draft: VoiceDraftSnapshot;
  text: string;
}

const previewKey = new PluginKey<VoicePreviewFork | null>("voice-preview-fork");

/** A view-only hypothesis: never part of the draft, clipboard, or undo history. */
function voicePreviewDecorationsFork(state: EditorState, preview: VoicePreviewFork | null) {
  if (!preview) return DecorationSet.empty;
  const map = serializeEditorDoc(state.doc);
  if (map.value !== preview.draft.text) return DecorationSet.empty;
  const position = (offset: number) =>
    flatToPm(map, collapsedToFlat(map, collapseExpandedComposerCursor(map.value, offset)));
  const from = position(preview.draft.selection.start);
  const to = position(preview.draft.selection.end);
  const decorations = [
    Decoration.widget(
      from,
      () => {
        const span = document.createElement("span");
        span.className = "text-muted-foreground";
        span.dataset.voicePreviewFork = "true";
        span.setAttribute("role", "status");
        span.setAttribute("aria-label", "Live transcript");
        span.textContent = preview.text;
        return span;
      },
      { side: -1 },
    ),
  ];
  if (from < to) decorations.push(Decoration.inline(from, to, { class: "hidden" }));
  return DecorationSet.create(state.doc, decorations);
}

export function createVoicePreviewPluginFork() {
  return new Plugin<VoicePreviewFork | null>({
    key: previewKey,
    state: {
      init: () => null,
      apply: (transaction, previous) => {
        const next = transaction.getMeta(previewKey) as VoicePreviewFork | null | undefined;
        return next === undefined ? previous : next;
      },
    },
    props: {
      decorations: (state) =>
        voicePreviewDecorationsFork(state, previewKey.getState(state) ?? null),
    },
  });
}

export const VoicePreviewExtensionFork = Extension.create({
  name: "voice-preview-fork",
  addProseMirrorPlugins() {
    return [createVoicePreviewPluginFork()];
  },
});

export function useVoicePreviewEditorFork(
  editor: Editor | null,
  preview: VoicePreviewFork | null | undefined,
) {
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    presentVoicePreviewFork(editor, preview ?? null);
  }, [editor, preview]);
}

function presentVoicePreviewFork(editor: Editor, preview: VoicePreviewFork | null) {
  editor.view.dispatch(editor.state.tr.setMeta(previewKey, preview));
  const element = editor.view.dom;
  const span = element.querySelector<HTMLElement>("[data-voice-preview-fork]");
  // Keep growing hypotheses visible inside the editor without scrolling the chat.
  if (span) element.scrollTop = span.offsetTop + span.offsetHeight - element.clientHeight;
}
