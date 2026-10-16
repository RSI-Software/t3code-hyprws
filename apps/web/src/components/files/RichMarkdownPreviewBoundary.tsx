import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import { isMarkdownPreviewFile } from "./filePreviewMode";
import {
  changeFileSaveSession,
  flushFileSaveSessionFork,
  useFileSaveSession,
} from "./fileSaveSessions";
import {
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const MarkdownRichEditor = lazy(() =>
  import("./MarkdownRichEditor").then(({ MarkdownRichEditor }) => ({
    default: MarkdownRichEditor,
  })),
);

export type MarkdownPreviewFileState = "loading" | "ready" | "truncated";

/**
 * Spread over the upstream rendered-preview toggle, after its own `label`, so the fork overrides
 * that prop instead of replacing the line that sets it. A non-Markdown file carries no `label`
 * here and keeps upstream's.
 */
export interface RichMarkdownToggleProps {
  readonly label?: string;
  readonly disabled: boolean;
}

export interface RichMarkdownPreviewMode {
  readonly isMarkdown: boolean;
  readonly isRichMarkdown: boolean;
  readonly rendered: boolean;
  readonly richEditorEnabled: boolean;
  readonly toggleDisabled: boolean;
  readonly toggleLabel: string;
  readonly tooltipLabel: string;
  readonly toggleProps: RichMarkdownToggleProps;
}

export function resolveRichMarkdownPreviewMode(input: {
  readonly relativePath: string | null;
  readonly fileState: MarkdownPreviewFileState;
  readonly renderPreferred: boolean;
  readonly revealHandled: boolean;
  readonly readOnly: boolean;
}): RichMarkdownPreviewMode {
  const isMarkdown = input.relativePath !== null && isMarkdownPreviewFile(input.relativePath);
  // Milkdown's Markdown parser cannot safely preserve JSX nodes. MDX stays on
  // the rendered preview surface rather than crossing the rich editor. Host
  // files are read-only, so their toggle must not advertise an editing mode.
  // A truncated read renders read-only on upstream's surface: saving it would drop the tail.
  const isRichMarkdown =
    !input.readOnly &&
    input.fileState !== "truncated" &&
    input.relativePath !== null &&
    /\.md$/i.test(input.relativePath);
  const rendered =
    isMarkdown && input.fileState !== "loading" && input.renderPreferred && input.revealHandled;
  const toggleLabel = rendered
    ? "Show markdown source"
    : isRichMarkdown
      ? "Edit as rich markdown"
      : "Show rendered markdown";

  const toggleDisabled = isMarkdown && input.fileState === "loading";

  return {
    isMarkdown,
    isRichMarkdown,
    rendered,
    richEditorEnabled: rendered && isRichMarkdown && !input.readOnly,
    toggleDisabled,
    toggleLabel,
    tooltipLabel: toggleLabel,
    toggleProps: isMarkdown
      ? { label: toggleLabel, disabled: toggleDisabled }
      : { disabled: false },
  };
}

export function publishRichMarkdownChange(input: {
  readonly nextContents: string;
  readonly currentContents: string;
  readonly setOptimistic: (contents: string) => void;
  readonly save: (contents: string) => void;
}): boolean {
  if (input.nextContents === input.currentContents) return false;
  input.setOptimistic(input.nextContents);
  input.save(input.nextContents);
  return true;
}

interface RichMarkdownPreviewBoundaryProps {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly theme: "light" | "dark";
  readonly wordWrap: boolean;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly children: ReactNode;
}

function RichMarkdownEditorSurface(props: RichMarkdownPreviewBoundaryProps) {
  useFileSaveSession(props, props.onPendingChange);

  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      }
    >
      <MarkdownRichEditor
        onSave={() => flushFileSaveSessionFork(props)}
        value={props.contents}
        cwd={props.cwd}
        relativePath={props.relativePath}
        onOpenFile={props.onOpenFile}
        theme={props.theme}
        wordWrap={props.wordWrap}
        onChange={(nextContents) => {
          const currentContents =
            getOptimisticProjectFileQueryData(props.environmentId, props.cwd, props.relativePath)
              ?.contents ?? props.contents;
          publishRichMarkdownChange({
            nextContents,
            currentContents,
            setOptimistic: (contents) =>
              setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, contents),
            save: (contents) => changeFileSaveSession(props, contents),
          });
        }}
      />
    </Suspense>
  );
}

export function RichMarkdownPreviewBoundary(props: RichMarkdownPreviewBoundaryProps) {
  return props.enabled ? <RichMarkdownEditorSurface {...props} /> : props.children;
}
