import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/core";
import { Plugin } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { useEffect, useRef, useState } from "react";

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
  readonly relativePath: string;
  readonly onOpenFile: (relativePath: string) => void;
  readonly theme: "light" | "dark";
  readonly wordWrap: boolean;
}

/**
 * Mounts a Milkdown editor into `root` and tears it down on unmount. Replaces
 * `@milkdown/react`, whose dependency closure drags `@milkdown/crepe` (and with it a Vue
 * runtime and CodeMirror) into a React-only app; the binding it provides is this effect.
 *
 * Two deliberate differences from `@milkdown/react`. `editorRef` is set synchronously, so a
 * caller reaching the editor before `create()` resolves gets the instance rather than null;
 * `ready` still gates every action, because the context it reads is only populated after
 * creation. And `ready` stays false when `create()` rejects, so a failed editor never runs a
 * post-creation action; `@milkdown/react` cleared its loading flag either way.
 */
function useMilkdownEditor(
  rootRef: React.RefObject<HTMLDivElement | null>,
  build: (root: HTMLElement) => Editor,
) {
  // Only the first factory is ever used, which is what `useEditor(factory, [])`
  // did: every value it closes over is a ref, so the first closure stays current.
  // A future capture that is not a ref would go stale here.
  const buildRef = useRef(build);
  const editorRef = useRef<Editor | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const editor = buildRef.current(root);
    editorRef.current = editor;
    let disposed = false;
    const created = editor
      .create()
      .then(() => {
        if (!disposed) setReady(true);
      })
      .catch((error: unknown) => {
        console.error("failed to create the Markdown editor", error);
      });

    return () => {
      disposed = true;
      setReady(false);
      editorRef.current = null;
      // `created` already reported its own failure; a teardown that fails after a
      // successful create is a leaked ProseMirror view and must not be silent.
      void created
        .then(() => editor.destroy())
        .catch((error: unknown) => {
          console.error("failed to destroy the Markdown editor", error);
        });
    };
  }, [rootRef]);

  return { editor: editorRef, ready };
}

export function MarkdownRichEditor({
  value,
  onChange,
  cwd,
  relativePath,
  onOpenFile,
  theme,
  wordWrap,
}: MarkdownRichEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const lastMarkdownRef = useRef(value);
  const cwdRef = useRef(cwd);
  const sourcePathRef = useRef(relativePath);
  const onOpenFileRef = useRef(onOpenFile);
  const themeRef = useRef(theme);
  onChangeRef.current = onChange;
  cwdRef.current = cwd;
  sourcePathRef.current = relativePath;
  onOpenFileRef.current = onOpenFile;
  themeRef.current = theme;

  const { editor, ready } = useMilkdownEditor(rootRef, (root) => {
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
      .use(
        markdownEditorPresentation({
          cwd: cwdRef,
          sourcePath: sourcePathRef,
          onOpenFile: onOpenFileRef,
          theme: themeRef,
        }),
      )
      .use(publishChanges);
  });

  useEffect(() => {
    if (!ready) return;
    editor.current?.action((ctx) =>
      refreshMarkdownEditorPresentation(ctx.get(editorViewCtx), theme),
    );
  }, [editor, ready, theme]);

  return (
    <div
      className="t3-markdown-editor min-h-0 flex-1 overflow-y-auto bg-background"
      data-word-wrap={wordWrap ? "true" : "false"}
    >
      <div data-milkdown-root ref={rootRef} />
    </div>
  );
}
