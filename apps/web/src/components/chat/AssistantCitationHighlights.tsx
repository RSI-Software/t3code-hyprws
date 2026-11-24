import type { AssistantCitation } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { useGT } from "gt-react";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "~/composerDraftStore";
import {
  assistantCitationLineAnchor,
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { AssistantCitationBadge } from "./AssistantCitationChip";
import {
  citedPassages,
  passageKey,
  placeCitationMarkers,
} from "./AssistantCitationHighlights.logic";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";

const DRAFT_HIGHLIGHT_NAME = "t3-assistant-citation-draft";
const SENT_HIGHLIGHT_NAME = "t3-assistant-citation-sent";
const PREVIEW_CLOSE_DELAY_MS = 180;
/** Outlasts `--animate-citation-pop`, so a marker remounting later stays still. */
const MARKER_POP_MS = 500;
const MARKERS = "[data-citation-markers]";

type Passage = {
  index: number;
  /** Cited by a message already sent, so it is no longer the draft's to edit. */
  sent: boolean;
  source: string;
  citation: AssistantCitation;
  anchor: AssistantCitationSourceAnchor;
};

type Marker = {
  passage: Passage;
  left: number;
  top: number;
  /** Milliseconds into its pop, so a marker remounting mid-pop resumes it; null once done. */
  popElapsed: number | null;
};

const samePlace = (a: Marker, b: Marker) =>
  a.passage.anchor.source === b.passage.anchor.source &&
  a.passage.source === b.passage.source &&
  a.passage.index === b.passage.index &&
  a.left === b.left &&
  a.top === b.top;

/** Swaps one owner's ranges in a shared highlight, registering it only while it has any. */
function replaceRanges(name: string, previous: ReadonlyArray<Range>, next: ReadonlyArray<Range>) {
  const highlight = CSS.highlights.get(name) ?? new Highlight();
  for (const range of previous) highlight.delete(range);
  for (const range of next) highlight.add(range);
  if (highlight.size > 0) CSS.highlights.set(name, highlight);
  else CSS.highlights.delete(name);
}

/** Each sent message's citation markdown, so re-renders while a turn streams skip the scan. */
const sentCitations = new WeakMap<ChatMessage, string>();
function sentCitationsOf(message: ChatMessage) {
  let sources = sentCitations.get(message);
  if (sources === undefined) {
    sources = collectAssistantCitations(message.text)
      .map(({ source }) => source)
      .join(" ");
    sentCitations.set(message, sources);
  }
  return sources;
}

/** A sent passage cannot change, so only its comment is worth previewing. */
const previewable = (passage: Passage) => !passage.sent || !!passage.citation.comment;

const rangesOf = (passages: ReadonlyArray<Passage>, sent: boolean) =>
  passages.flatMap((passage) => (passage.sent === sent ? [passage.anchor.range] : []));

/**
 * Tints the passages the composer draft cites and marks each with its chip's `❝n` badge.
 * Hovering one previews, edits, or removes it; clicking its marker edits its comment.
 * Passages sent messages cite stay faintly tinted, with a bare `❝` when they carry a comment.
 */
export function AssistantCitationHighlights({
  viewport,
  draftTarget,
  entries,
  onEditComment,
  onRemove,
}: {
  viewport: HTMLElement | null;
  /** Null while a pending question owns the composer; sent citations still show. */
  draftTarget: ComposerThreadTarget | null;
  entries: ReadonlyArray<TimelineEntry>;
  onEditComment: (citationStart: number, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
  onRemove: (citationStart: number, source: string) => boolean;
}) {
  const gt = useGT();
  // The citations' own markdown, so typing elsewhere in the draft does not re-render.
  const citationsKey = useComposerDraftStore((store) =>
    collectAssistantCitations(
      draftTarget ? (store.getComposerDraft(draftTarget)?.prompt ?? "") : "",
    )
      .map(({ source }) => source)
      .join(" "),
  );
  const sentKey = entries
    .flatMap((entry) => {
      if (entry.kind !== "message" || entry.message.role !== "user") return [];
      const sources = sentCitationsOf(entry.message);
      return sources ? [sources] : [];
    })
    .join(" ");
  const targetKey = draftTarget ? composerTargetKey(draftTarget) : null;
  const [preview, setPreview] = useState<
    (Passage & { citationsKey: string; sentKey: string }) | null
  >(null);
  const [markers, setMarkers] = useState<ReadonlyArray<Marker>>([]);
  /** When each citation's pop ends, by passage occurrence, for the draft the markers last showed. */
  const popsRef = useRef<{ targetKey: string | null; ends: Map<string, number> }>({
    targetKey: null,
    ends: new Map(),
  });
  // A preview opened before the citations changed may point at the wrong one.
  const open =
    preview?.citationsKey === citationsKey && preview.sentKey === sentKey ? preview : null;
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
    if (hit && previewable(hit)) {
      // The comment editor already shows this passage's comment.
      if (document.querySelector("[data-citation-comment-editor]")) return;
      popupHoveredRef.current = false;
      cancelClose();
      if (open?.index !== hit.index) setPreview({ ...hit, citationsKey, sentKey });
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
    const drafts = collectAssistantCitations(citationsKey);
    const citations = citedPassages(drafts, collectAssistantCitations(sentKey));
    // Passages a draft already cites when it first shows stay still; later citations pop in.
    const pops = popsRef.current;
    const baseline = pops.targetKey !== targetKey;
    if (baseline) pops.ends.clear();
    pops.targetKey = targetKey;
    // Keyed per occurrence, so citing a passage again pops the new badge.
    const seen = new Map<string, number>();
    const popKeys = drafts.map(({ citation }) => {
      const key = passageKey(citation);
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      return `${key}#${occurrence}`;
    });
    for (const key of pops.ends.keys()) if (!popKeys.includes(key)) pops.ends.delete(key);
    for (const key of popKeys) {
      if (!pops.ends.has(key)) pops.ends.set(key, baseline ? 0 : performance.now() + MARKER_POP_MS);
    }
    if (!viewport || citations.length === 0) return;
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    const cited = citations
      .map(({ citation }) => `[data-assistant-citation-source="${CSS.escape(citation.messageId)}"]`)
      .join();
    const isCited = (node: Node) =>
      node instanceof Element && (node.matches(cited) || node.querySelector(cited) !== null);
    const isMarkers = (node: Node) => node instanceof Element && node.closest(MARKERS) !== null;
    let painted: Passage[] = [];
    let placed: Marker[] = [];
    const resizes = new Map<HTMLElement, () => void>();
    let frame: number | null = null;
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(paint);
    };
    const paint = () => {
      frame = null;
      const next = citations.flatMap(({ citation, source }, index) => {
        const anchor = findAssistantCitationSourceAnchor(viewport, citation);
        return anchor ? [{ index, sent: index >= drafts.length, source, citation, anchor }] : [];
      });
      replaceRanges(DRAFT_HIGHLIGHT_NAME, rangesOf(painted, false), rangesOf(next, false));
      replaceRanges(SENT_HIGHLIGHT_NAME, rangesOf(painted, true), rangesOf(next, true));
      painted = next;
      // Markers follow their source as it reflows; stop watching sources that unmounted.
      for (const { anchor } of next) {
        if (!resizes.has(anchor.source))
          resizes.set(anchor.source, observeResize(anchor.source, schedule));
      }
      for (const [source, stop] of resizes) {
        if (!source.isConnected) {
          stop();
          resizes.delete(source);
        }
      }
      const ends = next.flatMap((passage) => {
        if (passage.sent && !passage.citation.comment) return [];
        const { range, source } = passage.anchor;
        const line = [...range.getClientRects()].findLast(({ width }) => width > 0);
        const bounds = source.getBoundingClientRect();
        const digits = passage.sent ? 0 : String(passage.index + 1).length;
        return line ? [{ passage, source: passage.citation.messageId, line, bounds, digits }] : [];
      });
      const now = performance.now();
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const nextPlaced = placeCitationMarkers(ends, rem).map(({ left, top }, i): Marker => {
        const passage = ends[i]!.passage;
        const popEnd = pops.ends.get(popKeys[passage.index] ?? "") ?? 0;
        const popElapsed = popEnd > now ? Math.round(now - popEnd + MARKER_POP_MS) : null;
        return { passage, left, top, popElapsed };
      });
      if (
        nextPlaced.length !== placed.length ||
        nextPlaced.some((marker, i) => !samePlace(marker, placed[i]!))
      ) {
        placed = nextPlaced;
        setMarkers(nextPlaced);
      }
    };
    // Streaming elsewhere in the thread leaves cited passages alone, so only their rows repaint.
    const observer = new MutationObserver((records) => {
      if (frame !== null) return;
      const changed = records.some((record) => {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (isMarkers(record.target) || (nodes.length > 0 && nodes.every(isMarkers))) return false;
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        return !!target?.closest(cited) || [...record.addedNodes].some(isCited);
      });
      if (changed) schedule();
    });
    // Markers ride the viewport's scroll; a nested scroller (a code block) moves text under them.
    const onScroll = (event: Event) => {
      if (event.target !== viewport) schedule();
    };
    const onMove = (event: PointerEvent) => {
      // A pressed button means a selection drag; the cite toolbar owns that.
      if (event.pointerType === "touch" || event.buttons !== 0) return;
      const marker =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-citation-marker]")
          : null;
      if (marker) {
        const index = Number(marker.dataset.citationMarker);
        onPointer(
          painted.find((passage) => passage.index === index) ?? null,
          event.clientX,
          event.clientY,
        );
        return;
      }
      const inside = (rect: DOMRect) =>
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      const overCited = event.target instanceof Element && event.target.closest(cited) !== null;
      // The innermost passage wins, so one cited inside another stays reachable.
      const hit = overCited
        ? painted
            .filter(
              (passage) =>
                previewable(passage) && [...passage.anchor.range.getClientRects()].some(inside),
            )
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
    viewport.addEventListener("scroll", onScroll, { capture: true, passive: true });
    paint();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      for (const stop of resizes.values()) stop();
      viewport.removeEventListener("scroll", onScroll, { capture: true });
      setMarkers([]);
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerleave", onLeave);
      viewport.removeEventListener("pointerdown", onDown);
      replaceRanges(DRAFT_HIGHLIGHT_NAME, rangesOf(painted, false), []);
      replaceRanges(SENT_HIGHLIGHT_NAME, rangesOf(painted, true), []);
      dismiss();
    };
  }, [viewport, citationsKey, sentKey, targetKey]);

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
    if (!draftTarget) return null;
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
  const bySource = new Map<HTMLElement, Marker[]>();
  for (const marker of markers) {
    const { source } = marker.passage.anchor;
    bySource.set(source, [...(bySource.get(source) ?? []), marker]);
  }
  return (
    <Popover
      open={open !== null}
      modal={false}
      onOpenChange={(next) => {
        if (!next) setPreview(null);
      }}
    >
      {[...bySource].map(([source, sourceMarkers]) =>
        createPortal(
          <span data-citation-markers="" data-thread-find-ignore="" className="contents">
            {sourceMarkers.map(({ passage, left, top, popElapsed }) => (
              <span
                key={passage.index}
                data-active={open?.index === passage.index || undefined}
                data-fresh={popElapsed !== null || undefined}
                className="absolute z-1 flex rounded-full ring-2 ring-background transition-[scale] duration-150 ease-out select-none data-active:scale-115 motion-safe:data-fresh:animate-citation-pop"
                style={{ left, top, animationDelay: popElapsed ? `-${popElapsed}ms` : undefined }}
              >
                <AssistantCitationBadge
                  number={passage.sent ? null : passage.index + 1}
                  render={
                    <button
                      type="button"
                      data-citation-marker={passage.index}
                      aria-label={
                        passage.sent
                          ? gt("View cited assistant text: {label}", {
                              label: assistantCitationLabel(passage.citation),
                            })
                          : gt("Citation {number}: {label}", {
                              number: passage.index + 1,
                              label: assistantCitationLabel(passage.citation),
                            })
                      }
                      onClick={() =>
                        passage.sent
                          ? setPreview({ ...passage, citationsKey, sentKey })
                          : edit(passage)
                      }
                      onFocus={(event) => {
                        if (!event.currentTarget.matches(":focus-visible")) return;
                        cancelClose();
                        setPreview({ ...passage, citationsKey, sentKey });
                      }}
                      onBlur={() => {
                        if (open?.index === passage.index) closeSoon();
                      }}
                    />
                  }
                />
              </span>
            ))}
          </span>,
          source,
          sourceMarkers[0]!.passage.citation.messageId,
        ),
      )}
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
            {open.sent ? null : (
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
            )}
          </div>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
