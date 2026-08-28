import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { PaperclipIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { uploadPullRequestAttachment } from "~/lib/pullRequestAttachmentUpload";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

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

/**
 * The box a body is rewritten in — a description, or a remark already posted. It owns the draft
 * and nothing else: the caller sends the request and says whether it is still in flight, so the
 * same box serves every mutation without knowing which one it is. A PR description may also be
 * given its host reference, which is what enables attachment uploads without exposing them on
 * ordinary comments.
 *
 * Preview renders through the same component the saved body will be read through, which is the
 * only way to see what a host's markdown will actually become before it is sent.
 */
export function PullRequestMarkdownEditor({
  value,
  cwd,
  environmentId,
  placeholder,
  label,
  saving,
  allowEmpty = false,
  attachment,
  className,
  onSave,
  onCancel,
}: {
  readonly value: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly saving: boolean;
  readonly allowEmpty?: boolean;
  /** Present only for a connected, host-backed PR description, never for an ordinary comment. */
  readonly attachment?:
    | { readonly reference: PullRequestRef; readonly httpBaseUrl: string }
    | undefined;
  readonly className?: string | undefined;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  const [upload, setUpload] = useState<
    | { readonly status: "uploading"; readonly file: File; readonly progress: number }
    | { readonly status: "failed"; readonly file: File; readonly message: string }
    | null
  >(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  // The words this draft started from. React keeps a component instance wherever the same
  // position and key come round again, so an editor opened on one remark can be handed another's
  // words without being rebuilt — and saving would then write the first remark's text onto the
  // second. Different words mean a different subject, and the draft starts again from them.
  const [seed, setSeed] = useState(value);
  if (seed !== value) {
    setSeed(value);
    setDraft(value);
    setUpload(null);
  }
  const empty = draft.trim().length === 0;
  const uploading = upload?.status === "uploading";
  const busy = saving || uploading;

  const uploadFile = async (file: File) => {
    if (!attachment) return;
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? draft.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const controller = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    setUpload({ status: "uploading", file, progress: 0 });
    try {
      const insertion = await uploadPullRequestAttachment({
        environmentId,
        reference: attachment.reference,
        httpBaseUrl: attachment.httpBaseUrl,
        file,
        signal: controller.signal,
        onProgress: (progress) => setUpload({ status: "uploading", file, progress }),
      });
      const inserted = insertPullRequestAttachment(draft, insertion, selectionStart, selectionEnd);
      setDraft(inserted.value);
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

  return (
    <div
      className={cn("space-y-2", className)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="flex items-center gap-1">
        <Button
          size="xs"
          variant={preview ? "ghost" : "outline"}
          disabled={busy}
          onClick={() => setPreview(false)}
        >
          Write
        </Button>
        <Button
          size="xs"
          variant={preview ? "outline" : "ghost"}
          disabled={busy}
          onClick={() => setPreview(true)}
        >
          Preview
        </Button>
      </div>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground">Nothing to preview.</p>
          ) : (
            <PullRequestMarkdown text={draft} cwd={cwd} environmentId={environmentId} />
          )}
        </div>
      ) : (
        <Textarea
          ref={textareaRef}
          autoFocus
          disabled={busy}
          value={draft}
          rows={6}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            if (!attachment) return;
            const file = Array.from(event.clipboardData.files)[0];
            if (!file) return;
            event.preventDefault();
            void uploadFile(file);
          }}
        />
      )}
      {attachment && !preview ? (
        <div className="space-y-1.5">
          <input
            ref={pickerRef}
            className="sr-only"
            type="file"
            accept=".png,.gif,.jpg,.jpeg,.svg,.mp4,.mov,.webm"
            aria-label="Choose attachment"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadFile(file);
            }}
          />
          <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => pickerRef.current?.click()}
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
                  onClick={() => uploadAbortRef.current?.abort()}
                >
                  <XIcon className="size-3" />
                </Button>
              </>
            ) : upload?.status === "failed" ? (
              <>
                <span role="alert" className="min-w-0 truncate text-destructive">
                  {upload.message}
                </span>
                <Button size="xs" variant="ghost" onClick={() => void uploadFile(upload.file)}>
                  Retry
                </Button>
              </>
            ) : (
              <span>Paste or choose an image or video, up to 10 MB.</span>
            )}
          </div>
          {upload?.status === "uploading" ? (
            <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className="h-full bg-foreground"
                style={{ width: `${upload.progress * 100}%` }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || (empty && !allowEmpty)}
          onClick={() => onSave(draft)}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
