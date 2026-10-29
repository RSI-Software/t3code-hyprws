import type { EnvironmentId } from "@t3tools/contracts";
import { PenLine, type IconNode } from "lucide";
import { LoaderCircle } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { isMarkdownPreviewFile } from "./filePreviewMode";
import type { WorkspaceImageUrl } from "./markdownImages.fork";
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

/**
 * Spread over upstream's rendered-preview `MorphIcon`, after its own `icon`, so a rich-editable
 * Markdown source shows the edit glyph instead of upstream's preview eye.
 */
export interface RichMarkdownIconProps {
  readonly icon?: IconNode;
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
  readonly iconProps: RichMarkdownIconProps;
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

  const toggleDisabled = isMarkdown && input.fileState !== "ready";
  const tooltipLabel =
    isMarkdown && input.fileState === "truncated"
      ? isRichMarkdown
        ? "Rich editing is unavailable for truncated files"
        : "Rendered preview is unavailable for truncated files"
      : toggleLabel;

  return {
    isMarkdown,
    isRichMarkdown,
    rendered,
    richEditorEnabled: rendered && isRichMarkdown && !input.readOnly,
    toggleDisabled,
    toggleLabel,
    tooltipLabel,
    toggleProps: isMarkdown
      ? { label: tooltipLabel, disabled: toggleDisabled }
      : { disabled: false },
    iconProps: isRichMarkdown && !rendered ? { icon: PenLine } : {},
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

function useWorkspaceImageUrl(environmentId: EnvironmentId, cwd: string): WorkspaceImageUrl {
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  return async (path) => {
    if (!canReadFiles || httpBaseUrl === null) return null;
    const result = await createUrl({
      environmentId,
      input: { resource: { _tag: "draft-workspace-file", cwd, path } },
    });
    return result._tag === "Success"
      ? resolveAssetUrl(httpBaseUrl, result.value.relativeUrl)
      : null;
  };
}

function RichMarkdownEditorSurface(props: RichMarkdownPreviewBoundaryProps) {
  useFileSaveSession(props, props.onPendingChange);
  const imageUrl = useWorkspaceImageUrl(props.environmentId, props.cwd);

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
        imageUrl={imageUrl}
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
