import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/core";
import { Plugin } from "@milkdown/prose/state";
import { $prose, replaceAll } from "@milkdown/utils";
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
 * Replaces `@milkdown/react`, whose closure drags a Vue runtime and CodeMirror in. Unlike it,
 * `editorRef` is set synchronously while `ready` gates every action (the context is populated
 * only after creation), and `ready` stays false when `create()` rejects, so a failed editor
 * never runs a post-creation action.
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

  // oxlint-disable-next-line t3code/react-effect-budget -- mounts and tears down the Milkdown/ProseMirror editor on the DOM root.
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
  const syncingValueRef = useRef(false);
  const cwdRef = useRef(cwd);
  const sourcePathRef = useRef(relativePath);
  const onOpenFileRef = useRef(onOpenFile);
  const themeRef = useRef(theme);
  // oxlint-disable-next-line t3code/react-effect-budget -- refreshes the latest-prop refs the Milkdown plugins read outside React.
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    cwdRef.current = cwd;
    sourcePathRef.current = relativePath;
    onOpenFileRef.current = onOpenFile;
    themeRef.current = theme;
  });

  const { editor, ready } = useMilkdownEditor(rootRef, (root) => {
    const publishChanges = $prose(
      (ctx) =>
        new Plugin({
          view: () => ({
            update(view, previousState) {
              if (view.state.doc.eq(previousState.doc)) return;
              const markdown = ctx.get(serializerCtx)(view.state.doc);
              // A disk change loaded below is not an edit: saving its serialized
              // form would rewrite the file the user never touched.
              if (syncingValueRef.current) {
                lastMarkdownRef.current = markdown;
                return;
              }
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

  // `value` echoes this editor's own changes back through the optimistic file,
  // so only a different value is new content from disk (refresh, reopen,
  // focus, or an agent edit). Unsaved edits stay in the optimistic file, so
  // they arrive here as the echo and are never replaced.
  // oxlint-disable-next-line t3code/react-effect-budget -- pushes disk changes of `value` into the Milkdown editor instance.
  useEffect(() => {
    if (!ready || value === lastMarkdownRef.current) return;
    // No try/finally: the React Compiler skips a hook that uses one.
    syncingValueRef.current = true;
    editor.current?.action(replaceAll(value));
    syncingValueRef.current = false;
  }, [editor, ready, value]);

  // oxlint-disable-next-line t3code/react-effect-budget -- pushes the theme into the Milkdown editor view's presentation.
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
