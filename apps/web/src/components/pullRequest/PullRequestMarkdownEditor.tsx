import { useState } from "react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  PullRequestAttachmentBarFork,
  usePullRequestAttachmentFork,
  type PullRequestAttachmentTarget,
} from "./PullRequestMarkdownEditor.fork"; // fork-hook: upstream-fixes/pr-editor-attachment-import

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

/**
 * The box a body is rewritten in — a description, or a remark already posted. It owns the draft
 * and nothing else: the caller sends the request and says whether it is still in flight, so the
 * same box serves every mutation without knowing which one it is.
 *
 * Preview renders through the same component the saved body will be read through, which is the
 * only way to see what a host's markdown will actually become before it is sent.
 */
export function PullRequestMarkdownEditor({
  value,
  cwd,
  environmentId,
  threadRef = null,
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
  /** Thread the editor sits beside, so links in its preview follow the link target setting. */
  readonly threadRef?: ScopedThreadRef | null;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly saving: boolean;
  /** A description may be cleared, which is how one is removed; a remark may not be emptied. */
  readonly allowEmpty?: boolean;
  /** fork-owned: present only for a connected, host-backed PR description. (upstream-shape debt) */
  readonly attachment?: PullRequestAttachmentTarget | undefined;
  readonly className?: string | undefined;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  // The words this draft started from. React keeps a component instance wherever the same
  // position and key come round again, so an editor opened on one remark can be handed another's
  // words without being rebuilt — and saving would then write the first remark's text onto the
  // second. Different words mean a different subject, and the draft starts again from them.
  const [seed, setSeed] = useState(value);
  const attachmentFork = usePullRequestAttachmentFork({
    attachment,
    environmentId,
    value,
    draft,
    setDraft,
  }); // fork-hook: upstream-fixes/pr-editor-attachment
  if (seed !== value) {
    setSeed(value);
    setDraft(value);
  }
  const empty = draft.trim().length === 0;
  const saveDisabled = attachmentFork.busy || (empty && !allowEmpty);

  return (
    <div
      className={cn("space-y-2", className)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!saveDisabled && !event.repeat) onSave(draft);
          return;
        }
        if (event.key !== "Escape" || attachmentFork.busy) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <ToggleGroup
        aria-label="Markdown editor mode"
        variant="segmented"
        value={[preview ? "preview" : "write"]}
        disabled={attachmentFork.busy}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "write" || mode === "preview") setPreview(mode === "preview");
        }}
      >
        <Toggle value="write">Write</Toggle>
        <Toggle value="preview">Preview</Toggle>
      </ToggleGroup>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground">Nothing to preview.</p>
          ) : (
            <PullRequestMarkdown
              text={draft}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
            />
          )}
        </div>
      ) : (
        <Textarea
          autoFocus
          disabled={attachmentFork.busy}
          value={draft}
          rows={6}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          {...attachmentFork.textareaProps} // fork-hook: upstream-fixes/pr-editor-attachment-textarea
        />
      )}
      {/* fork-hook: upstream-fixes/pr-editor-attachment-bar */}
      <PullRequestAttachmentBarFork
        fork={attachmentFork}
        attachment={attachment}
        busy={attachmentFork.busy}
        preview={preview}
      />
      {/* fork-hook-end */}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" disabled={attachmentFork.busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="outline" disabled={saveDisabled} onClick={() => onSave(draft)}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
