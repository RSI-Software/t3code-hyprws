// Fork-only: pull-request attachment upload behaviour for commit `1314ebcb28`
// (fix(web): upload media in pull request descriptions). The upstream
// `PullRequestMarkdownEditor` carries only marked hook lines pointing here;
// this module owns the upload state machine, the attach bar UI, and the
// insertion logic, so the upstream file stays byte-for-byte except for the
// listed debt lines.
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as React from "react";

import { uploadPullRequestAttachment } from "~/lib/pullRequestAttachmentUpload";

import { Button } from "../ui/button";

export interface PullRequestAttachmentTarget {
  readonly reference: PullRequestRef;
  readonly httpBaseUrl: string;
}

/** Insert markdown for an attachment around the current selection, blank-line padded. */
export function insertPullRequestAttachment(
  value: string,
  insertion: string,
  selectionStart: number,
  selectionEnd: number,
): { readonly value: string; readonly cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leading = before.length > 0 && !before.endsWith("\n") ? "\n\n" : "";
  const trailing = after.length > 0 && !after.startsWith("\n") ? "\n\n" : "";
  const inserted = `${leading}${insertion}${trailing}`;
  return { value: `${before}${inserted}${after}`, cursor: before.length + inserted.length };
}

type UploadForkState =
  | { readonly status: "uploading"; readonly file: File; readonly progress: number }
  | { readonly status: "publishing"; readonly file: File }
  | { readonly status: "failed"; readonly file: File; readonly message: string };

/**
 * Owns every piece of editor state the attachment upload needs: the visible
 * upload status, the textarea selection, the in-flight abort controller, and
 * the draft insertion. The upstream editor spreads `textareaProps` onto its
 * `Textarea` and renders `PullRequestAttachmentBarFork` beside it.
 */
export function usePullRequestAttachmentFork(input: {
  readonly attachment: PullRequestAttachmentTarget | undefined;
  readonly environmentId: EnvironmentId;
  readonly value: string;
  readonly draft: string;
  readonly setDraft: (next: string) => void;
}) {
  const [upload, setUpload] = useState<UploadForkState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // An upload still in flight when the subject changes, or the editor closes, must not land its
  // insertion on words it was never started from — and the visible status resets with the seed.
  useEffect(() => () => uploadAbortRef.current?.abort(), [input.value]);
  useEffect(() => {
    setUpload(null);
  }, [input.value]);

  const uploadFile = async (file: File) => {
    if (!input.attachment) return;
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? input.draft.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const controller = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    setUpload({ status: "uploading", file, progress: 0 });
    try {
      const insertion = await uploadPullRequestAttachment({
        environmentId: input.environmentId,
        reference: input.attachment.reference,
        httpBaseUrl: input.attachment.httpBaseUrl,
        file,
        signal: controller.signal,
        onProgress: (progress) => setUpload({ status: "uploading", file, progress }),
        onPublish: () => setUpload({ status: "publishing", file }),
      });
      if (controller.signal.aborted) return;
      const inserted = insertPullRequestAttachment(
        input.draft,
        insertion,
        selectionStart,
        selectionEnd,
      );
      input.setDraft(inserted.value);
      setUpload(null);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(inserted.cursor, inserted.cursor);
      });
    } catch (error) {
      if (controller.signal.aborted) {
        setUpload(null);
      } else {
        setUpload({
          status: "failed",
          file,
          message: error instanceof Error ? error.message : "Upload failed.",
        });
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
    }
  };

  return {
    busy: upload?.status === "uploading" || upload?.status === "publishing",
    upload,
    uploadFile,
    cancel: () => uploadAbortRef.current?.abort(),
    textareaProps: {
      ref: textareaRef,
      onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (!input.attachment) return;
        const file = Array.from(event.clipboardData.files)[0];
        if (!file) return;
        event.preventDefault();
        void uploadFile(file);
      },
    },
    pickerRef,
  };
}

/** The attach button, live upload status, retry row, and progress bar. */
export function PullRequestAttachmentBarFork(input: {
  readonly fork: ReturnType<typeof usePullRequestAttachmentFork>;
  readonly attachment: PullRequestAttachmentTarget | undefined;
  readonly busy: boolean;
  readonly preview: boolean;
}) {
  if (!input.attachment || input.preview) return null;
  const { fork } = input;
  const upload = fork.upload;
  const uploading = upload?.status === "uploading" || upload?.status === "publishing";
  return (
    <div className="space-y-1.5">
      <input
        ref={fork.pickerRef}
        className="sr-only"
        type="file"
        accept=".png,.gif,.jpg,.jpeg,.svg,.mp4,.mov,.webm"
        aria-label="Choose attachment"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void fork.uploadFile(file);
        }}
      />
      <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
        <Button
          size="xs"
          variant="ghost"
          disabled={input.busy}
          onClick={() => fork.pickerRef.current?.click()}
        >
          <PaperclipIcon className="size-3" />
          Attach
        </Button>
        {upload?.status === "uploading" ? (
          <>
            <span aria-live="polite" className="min-w-0 truncate">
              Uploading {upload.file.name}… {Math.round(upload.progress * 100)}%
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Cancel attachment upload"
              onClick={fork.cancel}
            >
              <XIcon className="size-3" />
            </Button>
          </>
        ) : upload?.status === "publishing" ? (
          <span aria-live="polite" className="min-w-0 truncate">
            Publishing {upload.file.name}…
          </span>
        ) : upload?.status === "failed" ? (
          <>
            <span role="alert" className="min-w-0 truncate text-destructive">
              {upload.message}
            </span>
            <Button size="xs" variant="ghost" onClick={() => void fork.uploadFile(upload.file)}>
              Retry
            </Button>
          </>
        ) : (
          <span>Paste or choose an image or video, up to 10 MB.</span>
        )}
      </div>
      {uploading ? (
        <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className="h-full bg-foreground"
            style={{
              width: `${(upload?.status === "uploading" ? upload.progress : 1) * 100}%`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
