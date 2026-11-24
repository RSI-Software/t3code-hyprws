import type { AssistantCitation } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { useGT } from "gt-react";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import {
  assistantCitationLineAnchor,
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";

const DRAFT_HIGHLIGHT_NAME = "t3-assistant-citation-draft";
const PREVIEW_CLOSE_DELAY_MS = 180;

type Passage = {
  index: number;
  source: string;
  citation: AssistantCitation;
  anchor: AssistantCitationSourceAnchor;
};

/** Swaps one owner's ranges in the shared draft highlight, registering it only while it has any. */
function replaceDraftRanges(previous: ReadonlyArray<Range>, next: ReadonlyArray<Range>) {
  const highlight = CSS.highlights.get(DRAFT_HIGHLIGHT_NAME) ?? new Highlight();
  for (const range of previous) highlight.delete(range);
  for (const range of next) highlight.add(range);
  if (highlight.size > 0) CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, highlight);
  else CSS.highlights.delete(DRAFT_HIGHLIGHT_NAME);
}

/** Tints the passages the composer draft cites; hovering one previews, edits, or removes it. */
export function AssistantCitationHighlights({
  viewport,
  draftTarget,
  onEditComment,
  onRemove,
}: {
  viewport: HTMLElement | null;
  draftTarget: ComposerThreadTarget;
  onEditComment: (citationStart: number, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
  onRemove: (citationStart: number, source: string) => boolean;
}) {
  const gt = useGT();
  // The citations' own markdown, so typing elsewhere in the draft does not re-render.
  const citationsKey = useComposerDraftStore((store) =>
    collectAssistantCitations(store.getComposerDraft(draftTarget)?.prompt ?? "")
      .map(({ source }) => source)
      .join(" "),
  );
  const [preview, setPreview] = useState<(Passage & { citationsKey: string }) | null>(null);
  // A preview opened before the draft's citations changed may point at the wrong one.
  const open = preview?.citationsKey === citationsKey ? preview : null;
  const popupRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  // React fires the popup's pointerenter before the viewport's native pointerleave.
  const popupHoveredRef = useRef(false);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const closeSoon = () => {
    cancelClose();
    if (popupHoveredRef.current) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setPreview(null);
    }, PREVIEW_CLOSE_DELAY_MS);
  };
  const dismiss = useEffectEvent(() => {
    cancelClose();
    setPreview(null);
  });
  const onPointer = useEffectEvent((hit: Passage | null, x: number, y: number) => {
    if (hit) {
      // The comment editor already shows this passage's comment.
      if (document.querySelector("[data-citation-comment-editor]")) return;
      popupHoveredRef.current = false;
      cancelClose();
      if (open?.index !== hit.index) setPreview({ ...hit, citationsKey });
      return;
    }
    if (!open || closeTimerRef.current !== null) return;
    // Keep the preview while the pointer crosses the box spanning the passage and its popup.
    const passage = open.anchor.range.getBoundingClientRect();
    const popup = popupRef.current?.getBoundingClientRect();
    const inCorridor =
      popup &&
      x >= Math.min(passage.left, popup.left) &&
      x <= Math.max(passage.right, popup.right) &&
      y >= Math.min(passage.top, popup.top) &&
      y <= Math.max(passage.bottom, popup.bottom);
    if (!inCorridor) closeSoon();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints CSS Highlight ranges over rendered markdown, repaints when cited rows mount or change, and hit-tests pointer moves against them
  useEffect(() => {
    const citations = collectAssistantCitations(citationsKey);
    if (!viewport || citations.length === 0) return;
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    const cited = citations
      .map(({ citation }) => `[data-assistant-citation-source="${CSS.escape(citation.messageId)}"]`)
      .join();
    const isCited = (node: Node) =>
      node instanceof Element && (node.matches(cited) || node.querySelector(cited) !== null);
    let painted: Passage[] = [];
    let frame: number | null = null;
    const paint = () => {
      frame = null;
      const next = citations.flatMap(({ citation, source }, index) => {
        const anchor = findAssistantCitationSourceAnchor(viewport, citation);
        return anchor ? [{ index, source, citation, anchor }] : [];
      });
      replaceDraftRanges(
        painted.map(({ anchor }) => anchor.range),
        next.map(({ anchor }) => anchor.range),
      );
      painted = next;
    };
    // Streaming elsewhere in the thread leaves cited passages alone, so only their rows repaint.
    const observer = new MutationObserver((records) => {
      if (frame !== null) return;
      const changed = records.some((record) => {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        return !!target?.closest(cited) || [...record.addedNodes].some(isCited);
      });
      if (changed) frame = requestAnimationFrame(paint);
    });
    const onMove = (event: PointerEvent) => {
      // A pressed button means a selection drag; the cite toolbar owns that.
      if (event.pointerType === "touch" || event.buttons !== 0) return;
      const inside = (rect: DOMRect) =>
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      const overCited = event.target instanceof Element && event.target.closest(cited) !== null;
      // The innermost passage wins, so one cited inside another stays reachable.
      const hit = overCited
        ? painted
            .filter(({ anchor }) => [...anchor.range.getClientRects()].some(inside))
            .toSorted((a, b) => a.citation.text.length - b.citation.text.length)[0]
        : undefined;
      onPointer(hit ?? null, event.clientX, event.clientY);
    };
    const onLeave = (event: PointerEvent) => onPointer(null, event.clientX, event.clientY);
    const onDown = () => dismiss();
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    viewport.addEventListener("pointermove", onMove, { passive: true });
    viewport.addEventListener("pointerleave", onLeave);
    viewport.addEventListener("pointerdown", onDown);
    paint();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerleave", onLeave);
      viewport.removeEventListener("pointerdown", onDown);
      replaceDraftRanges(
        painted.map(({ anchor }) => anchor.range),
        [],
      );
      dismiss();
    };
  }, [viewport, citationsKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tints the previewed passage through the shared comment highlight and closes when its source unmounts
  useEffect(() => {
    if (!open) return;
    return observeAssistantCitationCommentSource({
      anchor: open.anchor,
      citation: open.citation,
      onUnavailable: dismiss,
    });
  }, [open]);

  /** The open citation's place in the current draft, unless the draft changed under it. */
  const inDraft = (passage: Passage) => {
    const prompt = useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
    const target = collectAssistantCitations(prompt)[passage.index];
    return target?.source === passage.source ? target : null;
  };
  // A read-only composer refuses both, so the preview stays open.
  const edit = (passage: Passage) => {
    const target = inDraft(passage);
    // A fresh range, so closing a preview cannot untint the editor's passage.
    const range = passage.anchor.range.cloneRange();
    if (!target || onEditComment(target.start, { ...passage.anchor, range })) setPreview(null);
  };
  const remove = (passage: Passage) => {
    const target = inDraft(passage);
    if (!target || onRemove(target.start, target.source)) setPreview(null);
  };
  const comment = open?.citation.comment?.trim();
  return (
    <Popover
      open={open !== null}
      modal={false}
      onOpenChange={(next) => {
        if (!next) setPreview(null);
      }}
    >
      {open ? (
        <PopoverPopup
          ref={popupRef}
          anchor={assistantCitationLineAnchor(open.anchor, "first")}
          side="top"
          align="start"
          width="sm"
          padding="compact"
          initialFocus={false}
          finalFocus={false}
          onPointerEnter={() => {
            popupHoveredRef.current = true;
            cancelClose();
          }}
          onPointerLeave={() => {
            popupHoveredRef.current = false;
            closeSoon();
          }}
        >
          <div className="flex items-start gap-2">
            <p
              className={cn(
                "min-w-0 flex-1 py-0.5 text-sm whitespace-pre-wrap wrap-break-word",
                !comment && "text-muted-foreground",
              )}
              dir={comment ? textDirection(comment) : undefined}
            >
              {comment || gt("Add a comment")}
            </p>
            <div className="-me-1 flex shrink-0">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={comment ? gt("Edit citation comment") : gt("Add comment to citation")}
                onClick={() => edit(open)}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Remove {name}", { name: assistantCitationLabel(open.citation) })}
                onClick={() => remove(open)}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </div>
          </div>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
