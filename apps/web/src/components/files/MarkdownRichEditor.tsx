import {
  defaultValueCtx,
  Editor,
  editorViewOptionsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { useRef } from "react";

import { markdownPipeline } from "./markdownPipeline";
import "./markdown-rich-editor.css";

interface MarkdownRichEditorProps {
  readonly value: string;
  readonly onChange: (markdown: string) => void;
}

function MarkdownRichEditorInner({ value, onChange }: MarkdownRichEditorProps) {
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const lastMarkdownRef = useRef(value);
  onChangeRef.current = onChange;

  useEditor((root) => {
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
    ).use(publishChanges);
  }, []);

  return <Milkdown />;
}

export function MarkdownRichEditor(props: MarkdownRichEditorProps) {
  return (
    <div className="t3-markdown-editor min-h-0 flex-1 overflow-y-auto bg-background">
      <MilkdownProvider>
        <MarkdownRichEditorInner {...props} />
      </MilkdownProvider>
    </div>
  );
}
