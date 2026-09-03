import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderCircle, PenLine } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { projectEnvironment } from "~/state/projects";

import { isMarkdownPreviewFile } from "./filePreviewMode";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const MarkdownRichEditor = lazy(() =>
  import("./MarkdownRichEditor").then(({ MarkdownRichEditor }) => ({
    default: MarkdownRichEditor,
  })),
);

const FILE_SAVE_DEBOUNCE_MS = 500;

export type MarkdownPreviewFileState = "loading" | "ready" | "truncated";

export interface RichMarkdownPreviewMode {
  readonly isMarkdown: boolean;
  readonly isRichMarkdown: boolean;
  readonly rendered: boolean;
  readonly richEditorEnabled: boolean;
  readonly toggleDisabled: boolean;
  readonly toggleLabel: string;
  readonly tooltipLabel: string;
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
  const isRichMarkdown =
    !input.readOnly && input.relativePath !== null && /\.md$/i.test(input.relativePath);
  const rendered =
    isMarkdown && input.fileState === "ready" && input.renderPreferred && input.revealHandled;
  const toggleLabel = rendered
    ? "Show markdown source"
    : isRichMarkdown
      ? "Edit as rich markdown"
      : "Show rendered markdown";

  return {
    isMarkdown,
    isRichMarkdown,
    rendered,
    richEditorEnabled: rendered && isRichMarkdown && !input.readOnly,
    toggleDisabled: isMarkdown && input.fileState !== "ready",
    toggleLabel,
    tooltipLabel:
      isMarkdown && input.fileState === "truncated"
        ? isRichMarkdown
          ? "Rich editing is unavailable for truncated files"
          : "Rendered preview is unavailable for truncated files"
        : toggleLabel,
  };
}

export function RichMarkdownEditIcon(props: { readonly className?: string }) {
  return <PenLine className={props.className} />;
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
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const saveCoordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => props.onPendingChange(props.relativePath, pending),
        persist: (nextContents) =>
          writeFile({
            environmentId: props.environmentId,
            input: { cwd: props.cwd, relativePath: props.relativePath, contents: nextContents },
          }),
        onConfirmed: (confirmedContents) => {
          confirmProjectFileQueryData(
            props.environmentId,
            props.cwd,
            props.relativePath,
            confirmedContents,
          );
        },
      }),
    [props.cwd, props.environmentId, props.onPendingChange, props.relativePath, writeFile],
  );

  useEffect(() => () => saveCoordinator.dispose(), [saveCoordinator]);

  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      }
    >
      <MarkdownRichEditor
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
            save: (contents) => saveCoordinator.change(contents),
          });
        }}
      />
    </Suspense>
  );
}

export function RichMarkdownPreviewBoundary(props: RichMarkdownPreviewBoundaryProps) {
  return props.enabled ? <RichMarkdownEditorSurface {...props} /> : props.children;
}
