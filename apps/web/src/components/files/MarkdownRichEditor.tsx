import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { useEffect, useRef } from "react";

import {
  markdownEditorPresentation,
  refreshMarkdownEditorPresentation,
} from "./markdownEditorPresentation";
import { markdownPipeline } from "./markdownPipeline";
import "./markdown-rich-editor.css";

interface MarkdownRichEditorProps {
  readonly value: string;
  readonly onChange: (markdown: string) => void;
  readonly cwd: string;
  readonly onOpenFile: (relativePath: string) => void;
  readonly theme: "light" | "dark";
  readonly wordWrap: boolean;
}

function MarkdownRichEditorInner({
  value,
  onChange,
  cwd,
  onOpenFile,
  theme,
}: MarkdownRichEditorProps) {
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const lastMarkdownRef = useRef(value);
  const cwdRef = useRef(cwd);
  const onOpenFileRef = useRef(onOpenFile);
  const themeRef = useRef(theme);
  onChangeRef.current = onChange;
  cwdRef.current = cwd;
  onOpenFileRef.current = onOpenFile;
  themeRef.current = theme;

  const editor = useEditor((root) => {
    const publishChanges = $prose(
      (ctx) =>
        new Plugin({
          view: () => ({
            update(view, previousState) {
              if (view.state.doc.eq(previousState.doc)) return;
              const markdown = ctx.get(serializerCtx)(view.state.doc);
              if (markdown === lastMarkdownRef.current) return;
              lastMarkdownRef.current = markdown;
              onChangeRef.current(markdown);
            },
          }),
        }),
    );

    return markdownPipeline(
      Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialValueRef.current);
        ctx.update(editorViewOptionsCtx, (previous) => ({
          ...previous,
          attributes: {
            class: "t3-markdown-editor__prose",
            spellcheck: "true",
          },
        }));
      }),
    )
      .use(markdownEditorPresentation({ cwd: cwdRef, onOpenFile: onOpenFileRef, theme: themeRef }))
      .use(publishChanges);
  }, []);

  useEffect(() => {
    if (editor.loading) return;
    editor.get()?.action((ctx) => refreshMarkdownEditorPresentation(ctx.get(editorViewCtx), theme));
  }, [editor, theme]);

  return <Milkdown />;
}

export function MarkdownRichEditor(props: MarkdownRichEditorProps) {
  return (
    <div
      className="t3-markdown-editor min-h-0 flex-1 overflow-y-auto bg-background"
      data-word-wrap={props.wordWrap ? "true" : "false"}
    >
      <MilkdownProvider>
        <MarkdownRichEditorInner {...props} />
      </MilkdownProvider>
    </div>
  );
}
