import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { DecorationSet } from "@tiptap/pm/view";
import { describe, expect, it } from "vite-plus/test";
import { buildDocJson, serializeEditorDoc } from "../composer-rich-text-doc";
import { createVoicePreviewPluginFork, type VoicePreviewFork } from "./preview.fork";

const schema = getSchema([StarterKit]);
const labels = (name: string) => ({ label: name, description: null });

function fixture(text: string, selection = { start: text.length, end: text.length }) {
  const plugin = createVoicePreviewPluginFork();
  const state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(buildDocJson(text, labels)),
    plugins: [history(), plugin],
  });
  const preview: VoicePreviewFork = {
    draft: { ownerKey: "draft", text, selection, revision: 0 },
    text: " live words",
  };
  const decorations = (next: EditorState) => {
    const source = plugin.props.decorations?.call(plugin, next);
    return source instanceof DecorationSet ? source.find() : [];
  };
  return { plugin, state, preview, decorations };
}

describe("live dictation editor preview", () => {
  it("replaces cumulative hypotheses without changing the draft or selection", () => {
    const { plugin, state, preview, decorations } = fixture("Keep this.");
    const first = state.apply(state.tr.setMeta(plugin, preview));
    const next = first.apply(first.tr.setMeta(plugin, { ...preview, text: " corrected words" }));
    expect(decorations(first)).toHaveLength(1);
    expect(decorations(next)).toHaveLength(1);
    expect(serializeEditorDoc(next.doc).value).toBe("Keep this.");
    expect(next.selection.eq(state.selection)).toBe(true);
    expect(decorations(next.apply(next.tr.setMeta(plugin, null)))).toEqual([]);
  });

  it("previews replacement at the captured selection and preserves its original text", () => {
    const { plugin, state, preview, decorations } = fixture("old draft", { start: 0, end: 3 });
    const next = state.apply(state.tr.setMeta(plugin, preview));
    expect(decorations(next).map(({ from, to }) => [from, to])).toEqual([
      [1, 1],
      [1, 4],
    ]);
    expect(serializeEditorDoc(next.doc).value).toBe("old draft");
  });

  it("does not leak a preview onto a changed draft or into undo history", () => {
    const { plugin, state, preview, decorations } = fixture("Original");
    const edited = state.apply(state.tr.insertText(" edit", 9));
    const shown = edited.apply(
      edited.tr.setMeta(plugin, { ...preview, draft: { ...preview.draft, text: "Original edit" } }),
    );
    const stale = shown.apply(shown.tr.setMeta(plugin, preview));
    expect(decorations(stale)).toEqual([]);
    let reverted = stale;
    expect(
      undo(stale, (transaction) => {
        reverted = stale.apply(transaction);
      }),
    ).toBe(true);
    expect(serializeEditorDoc(reverted.doc).value).toBe("Original");
  });

  it("maps captured Markdown offsets through styled text", () => {
    const { plugin, state, preview, decorations } = fixture("**bold** tail", { start: 8, end: 8 });
    const next = state.apply(state.tr.setMeta(plugin, preview));
    expect(decorations(next).map(({ from }) => from)).toEqual([5]);
  });
});
