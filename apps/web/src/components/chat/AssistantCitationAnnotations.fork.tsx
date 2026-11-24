import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { assistantCitationLabel } from "@t3tools/shared/assistantCitations";
import { useGT } from "gt-react";
import { PencilIcon, QuoteIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { queuedRunEditDraftId, useComposerDraftStore } from "~/composerDraftStore";
import { resolveAssistantCitationRange } from "~/lib/assistantTextSelection";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import type { TimelineEntry } from "../../session-logic";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useCollaboratorCitationsFork } from "../collaborator/CollaboratorChat.fork";
import { HOST_NAME } from "../collaborator/CollaboratorTyping.fork";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import {
  PEER_HUES,
  threadAnnotations,
  withDraftCitationComment,
  withoutDraftCitation,
  type Annotation,
} from "./assistantCitationAnnotations.fork";
import { queuedRunEdits } from "./useQueuedRunEdit";

const HIGHLIGHT = {
  draft: "t3-annotation-draft",
  sent: "t3-annotation-sent",
  active: "t3-annotation-active",
  activePeer: "t3-annotation-active-peer",
} as const;
/** One per hue, so each person's live citations wear their colour. */
const PEER_HIGHLIGHTS = Array.from({ length: PEER_HUES }, (_, hue) => `t3-annotation-peer-${hue}`);
const ALL_HIGHLIGHTS = [...Object.values(HIGHLIGHT), ...PEER_HIGHLIGHTS];
const LAYER = "[data-annotation-layer]";
const COMPOSER_CHIP = ".composer-tiptap [data-assistant-citation-chip]";
const POPUP = "[data-annotation-popup]";
const TEXT_HOVER_CLOSE_MS = 180;
/** Marker height in px; matches the marker's `h-3.5`. */
const MARKER_SIZE = 14;
/** How far a marker reaches into its line's text box, which pads above the capitals. */
const MARKER_LIFT = 4;
/** Gap between markers sharing a line. */
const MARKER_GAP = 2;
/** Outlasts `--animate-annotation-pop`, so a row remounting later stays still. */
const POP_MS = 500;

type Marker = {
  annotation: Annotation;
  /** Room the marker takes when it shares a line or clamps to the lane edge. */
  width: number;
  source: HTMLElement;
  /** Milliseconds into the pop, so a row remounting mid-pop resumes it; null once done. */
  popElapsed: number | null;
  left: number;
  top: number;
};
type OpenState = { key: string; editing: boolean; fromText: boolean };

const passageId = ({ threadId, messageId, start, end }: Annotation["citation"]) =>
  `${threadId}:${messageId}:${start}:${end}`;

type Owned = Map<string, ReadonlyArray<Range>>;
const sharedHighlights = new Map<string, Highlight>();

/** Every mounted timeline shares one Highlight per name and swaps only the ranges it owns. */
function own(owned: Owned, name: string, next: ReadonlyArray<Range>) {
  let highlight = sharedHighlights.get(name);
  if (!highlight) {
    sharedHighlights.set(name, (highlight = new Highlight()));
    // The hovered passage paints over every other mark it overlaps.
    if (name === HIGHLIGHT.active || name === HIGHLIGHT.activePeer) highlight.priority = 1;
  }
  for (const range of owned.get(name) ?? []) highlight.delete(range);
  for (const range of next) highlight.add(range);
  owned.set(name, next);
  if (highlight.size > 0) CSS.highlights.set(name, highlight);
  else CSS.highlights.delete(name);
}

function paintActive(
  owned: Owned,
  ranges: ReadonlyMap<string, Range>,
  others: ReadonlySet<string>,
  key: string | null,
) {
  const range = key ? ranges.get(key) : undefined;
  const theirs = key !== null && others.has(key);
  own(owned, HIGHLIGHT.active, range && !theirs ? [range] : []);
  own(owned, HIGHLIGHT.activePeer, range && theirs ? [range] : []);
}

const peerStyle = (hue: number | null) =>
  (hue === null ? {} : { "--annotation-peer": `var(--annotation-peer-${hue})` }) as CSSProperties;

/** Who sent a message, as this viewer names them; null for the viewer's own. */
const ownerOf = (
  guestName: string | undefined,
  { hostName, you }: { hostName: string | null; you: string | null },
) => (guestName === undefined ? hostName : guestName === you ? null : guestName);

/** A cite's first letter, so a marker says whose it is. */
const initialOf = (owner: string) => [...owner.trim()][0]?.toLocaleUpperCase() ?? "?";

/** Rough rendered width: padding plus one slot per glyph (`❝`, an initial, digits). */
function markerWidth({ draftNumber }: Annotation) {
  const digits = draftNumber === null ? 0 : String(draftNumber).length;
  return 14 + 6 * (1 + digits);
}

/** Markers on one line keep their order but never overlap, and stay inside the lane. */
function layOutLine(line: Marker[], laneWidth: number) {
  line.sort((a, b) => a.left - b.left);
  let cursor = Number.NEGATIVE_INFINITY;
  for (const marker of line) {
    marker.left = Math.max(marker.left, cursor + MARKER_GAP);
    cursor = marker.left + marker.width;
  }
  const overflow = cursor - laneWidth;
  if (overflow > 0) {
    const shift = Math.min(overflow, line[0]!.left);
    for (const marker of line) marker.left -= shift;
  }
}

const supported = () =>
  typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight !== "undefined";

const ownNode = (node: Node | null) =>
  !!(node?.nodeType === 1 ? (node as Element) : node?.parentElement)?.closest(LAYER);

function findSource(viewport: HTMLElement, annotation: Annotation) {
  const { messageId, threadId } = annotation.citation;
  return viewport.querySelector<HTMLElement>(
    `[data-assistant-citation-source="${CSS.escape(messageId)}"]` +
      `[data-assistant-citation-thread="${CSS.escape(threadId)}"]`,
  );
}

/** Keeps cited passages marked in the transcript, with their comment one hover away. */
export function AssistantCitationAnnotations({
  viewport,
  threadRef,
  entries,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef | null;
  entries: ReadonlyArray<TimelineEntry>;
}) {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  // Editing a queued message swaps the composer onto that run's draft.
  const queuedEdit = useAtomValue(queuedRunEdits.atom)[threadKey ?? ""];
  const draftTarget =
    threadRef && queuedEdit ? queuedRunEditDraftId(threadRef, queuedEdit.runId) : threadRef;
  const draft = useComposerDraftStore((store) =>
    draftTarget ? (store.getComposerDraft(draftTarget)?.prompt ?? "") : "",
  );
  const collaborators = useCollaboratorCitationsFork(threadRef);
  const sent = entries.flatMap((entry) =>
    entry.kind === "message" && entry.message.role === "user"
      ? [
          {
            id: entry.id,
            text: entry.message.text,
            owner: ownerOf(resolveUserMessagePresentation(entry.message).guestName, collaborators),
          },
        ]
      : [],
  );
  // A string key keeps the effects from re-running on every streamed timeline update.
  const annotationsKey = JSON.stringify(
    threadRef
      ? threadAnnotations(
          threadRef,
          draft,
          [...sent, ...collaborators.waiting],
          collaborators.peers,
          collaborators.you ?? HOST_NAME,
        )
      : [],
  );
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [open, setOpen] = useState<OpenState | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const rangesRef = useRef(new Map<string, Range>());
  /** Keys of passages someone else cited, which hover in a neutral tone. */
  const othersRef = useRef(new Set<string>());
  const ownedRef = useRef<Owned>(new Map());
  /** Thread keys and passage ids already seen, with the time a passage's pop ends. */
  const seenRef = useRef(new Map<string, number>());
  const closeTimerRef = useRef<number | null>(null);
  // React fires the popup's pointerenter before the viewport's native pointerleave.
  const popupHoveredRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints CSS Highlight ranges and places markers over rendered markdown, repainting when rows remount, stream, or reflow
  useEffect(() => {
    const ranges = rangesRef.current;
    const others = othersRef.current;
    const owned = ownedRef.current;
    if (!viewport || !supported()) return;
    const annotations = JSON.parse(annotationsKey) as Annotation[];
    // Only passages cited after a thread first paints pop in; reopening a thread stays still.
    const seen = seenRef.current;
    const baseline = threadKey !== null && !seen.has(threadKey);
    if (threadKey !== null) seen.set(threadKey, 0);
    for (const { citation } of annotations) {
      const id = passageId(citation);
      if (!seen.has(id)) seen.set(id, baseline ? 0 : performance.now() + POP_MS);
    }
    const sourceResizes = new Map<HTMLElement, () => void>();
    const clear = () => {
      for (const name of ALL_HIGHLIGHTS) own(owned, name, []);
      ranges.clear();
      others.clear();
      setMarkers([]);
    };
    if (annotations.length === 0) {
      clear();
      return;
    }
    const cited = new Set(annotations.map(({ citation }) => citation.messageId as string));
    let painted: Marker[] = [];
    const paint = () => {
      const next: Marker[] = [];
      const draftRanges: Range[] = [];
      const sentRanges: Range[] = [];
      const peerRanges = PEER_HIGHLIGHTS.map((): Range[] => []);
      const lines = new Map<string, { marker: Marker; laneWidth: number }[]>();
      const now = performance.now();
      ranges.clear();
      others.clear();
      for (const annotation of annotations) {
        const source = findSource(viewport, annotation);
        const range = source && resolveAssistantCitationRange(source, annotation.citation);
        if (!source || !range) continue;
        if (!sourceResizes.has(source)) sourceResizes.set(source, observeResize(source, schedule));
        ranges.set(annotation.key, range);
        if (annotation.owner !== null) others.add(annotation.key);
        // Someone else's passage keeps their colour and marker once sent, so it stays theirs.
        if (annotation.hue !== null) peerRanges[annotation.hue]!.push(range);
        else if (annotation.draftNumber === null) sentRanges.push(range);
        else draftRanges.push(range);
        if (
          annotation.draftNumber === null &&
          annotation.owner === null &&
          !annotation.citation.comment
        )
          continue;
        const line = Array.from(range.getClientRects()).findLast((rect) => rect.width > 0);
        if (!line) continue;
        const bounds = source.getBoundingClientRect();
        // Overlays cannot reflow text, so the marker sits above the line like a footnote,
        // clear of the glyphs: a passage ending mid-line keeps the next word readable.
        const left = Math.round(line.right - bounds.left + 1);
        const top = Math.round(line.top - bounds.top - MARKER_SIZE + MARKER_LIFT);
        const popEnd = seen.get(passageId(annotation.citation)) ?? 0;
        const marker: Marker = {
          annotation,
          width: markerWidth(annotation),
          source,
          popElapsed: popEnd > now ? Math.round(now - (popEnd - POP_MS)) : null,
          left,
          top,
        };
        next.push(marker);
        // Passages ending on one line, or one passage cited by several people, share its markers.
        const lineKey = `${annotation.citation.messageId}:${top}`;
        lines.set(lineKey, [...(lines.get(lineKey) ?? []), { marker, laneWidth: bounds.width }]);
      }
      for (const line of lines.values()) {
        layOutLine(
          line.map(({ marker }) => marker),
          line[0]!.laneWidth,
        );
      }
      // Virtualized rows unmount; stop watching sources that left the DOM.
      for (const [source, stop] of sourceResizes) {
        if (!source.isConnected) {
          stop();
          sourceResizes.delete(source);
        }
      }
      own(owned, HIGHLIGHT.draft, draftRanges);
      own(owned, HIGHLIGHT.sent, sentRanges);
      PEER_HIGHLIGHTS.forEach((name, hue) => own(owned, name, peerRanges[hue]!));
      paintActive(owned, ranges, others, activeKeyRef.current);
      const changed =
        next.length !== painted.length ||
        next.some(
          (marker, index) =>
            marker.source !== painted[index]!.source ||
            marker.left !== painted[index]!.left ||
            marker.top !== painted[index]!.top ||
            marker.annotation.key !== painted[index]!.annotation.key,
        );
      if (changed) {
        painted = next;
        setMarkers(next);
      }
    };
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        paint();
      });
    };
    // Repaint only when a cited source changes or rows mount and unmount; ignore marker layers.
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (ownNode(record.target)) return false;
        if (record.type === "childList") {
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (node.nodeType === 1 && !(node as Element).matches(LAYER)) return true;
          }
        }
        const element =
          record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
        const source = element?.closest<HTMLElement>("[data-assistant-citation-source]");
        return !!source && cited.has(source.dataset.assistantCitationSource ?? "");
      });
      if (relevant) schedule();
    });
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    const stopResize = observeResize(viewport, schedule);
    // Markers ride the viewport's own scroll; a nested scroller (a code block) moves text under them.
    const onNestedScroll = (event: Event) => event.target !== viewport && schedule();
    viewport.addEventListener("scroll", onNestedScroll, { capture: true, passive: true });
    paint();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      stopResize();
      for (const stop of sourceResizes.values()) stop();
      viewport.removeEventListener("scroll", onNestedScroll, { capture: true });
      clear();
    };
  }, [viewport, annotationsKey, threadKey]);

  // The hovered passage wins; otherwise the one whose popover is open, by pointer or keyboard.
  const activeKey = hoveredKey ?? open?.key ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the active passage into the CSS Highlight registry, which lives outside React
  useEffect(() => {
    activeKeyRef.current = activeKey;
    if (supported()) paintActive(ownedRef.current, rangesRef.current, othersRef.current, activeKey);
  }, [activeKey]);
  const cancelClose = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const closeTextPreviewSoon = () => {
    cancelClose();
    if (popupHoveredRef.current) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen((current) => (current?.fromText && !current.editing ? null : current));
    }, TEXT_HOVER_CLOSE_MS);
  };

  const onTextHover = useEffectEvent((key: string | null) => {
    setHoveredKey(key);
    if (key) {
      popupHoveredRef.current = false;
      cancelClose();
      setOpen((current) =>
        current?.editing || current?.key === key
          ? current
          : { key, editing: false, fromText: true },
      );
    } else closeTextPreviewSoon();
  });
  const onComposerChipHover = useEffectEvent((index: number) =>
    setHoveredKey(index >= 0 ? `draft:${index}` : null),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hit-tests pointer moves against painted ranges and composer chips, which have no React handlers here
  useEffect(() => {
    if (!viewport) return;
    let hovered: string | null = null;
    const hover = (key: string | null) => {
      if (key === hovered) return;
      hovered = key;
      onTextHover(key);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || (event.target as Element).closest?.(LAYER)) return;
      const { clientX: x, clientY: y } = event;
      const inside = (rect: DOMRect) =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      // Overlapping passages: the shortest under the pointer wins, so a nested cite stays reachable.
      let hit: { key: string; length: number } | null = null;
      for (const [key, range] of rangesRef.current) {
        if (![...range.getClientRects()].some(inside)) continue;
        const length = range.toString().length;
        if (hit === null || length < hit.length) hit = { key, length };
      }
      if (hit) return hover(hit.key);
      // Keep the preview while the pointer crosses the box spanning the passage and its popup.
      const passage = hovered ? rangesRef.current.get(hovered)?.getBoundingClientRect() : null;
      const popup = document.querySelector(POPUP)?.getBoundingClientRect();
      if (passage && popup) {
        const left = Math.min(passage.left, popup.left);
        const top = Math.min(passage.top, popup.top);
        const corridor = new DOMRect(
          left,
          top,
          Math.max(passage.right, popup.right) - left,
          Math.max(passage.bottom, popup.bottom) - top,
        );
        if (inside(corridor)) return;
      }
      hover(null);
    };
    const onLeave = () => hover(null);
    const onComposerChip = (event: PointerEvent) => {
      const chip = (event.target as Element).closest?.(COMPOSER_CHIP);
      const editor = chip?.closest(".composer-tiptap");
      onComposerChipHover(
        chip && editor ? [...editor.querySelectorAll(COMPOSER_CHIP)].indexOf(chip) : -1,
      );
    };
    viewport.addEventListener("pointermove", onMove, { passive: true });
    viewport.addEventListener("pointerleave", onLeave);
    document.addEventListener("pointerover", onComposerChip, { passive: true });
    return () => {
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("pointerover", onComposerChip);
    };
  }, [viewport]);

  const saveComment = (annotation: Annotation, comment: string) => {
    if (!draftTarget || annotation.draftNumber === null || annotation.owner !== null) return false;
    const store = useComposerDraftStore.getState();
    const next = withDraftCitationComment(
      store.getComposerDraft(draftTarget)?.prompt ?? "",
      annotation.draftNumber,
      comment,
    );
    if (next === null) return false;
    store.setPrompt(draftTarget, next);
    setOpen(null);
    return true;
  };
  const remove = (annotation: Annotation) => {
    if (!draftTarget || annotation.draftNumber === null || annotation.owner !== null) return;
    const store = useComposerDraftStore.getState();
    const next = withoutDraftCitation(
      store.getComposerDraft(draftTarget)?.prompt ?? "",
      annotation.draftNumber,
    );
    if (next !== null) store.setPrompt(draftTarget, next);
    setOpen(null);
  };

  const bySource = new Map<HTMLElement, Marker[]>();
  for (const marker of markers) {
    bySource.set(marker.source, [...(bySource.get(marker.source) ?? []), marker]);
  }
  return [...bySource].map(([source, sourceMarkers]) =>
    createPortal(
      <div data-annotation-layer="" data-thread-find-ignore="" className="contents">
        {sourceMarkers.map((marker) => (
          <AnnotationMarker
            key={marker.annotation.key}
            marker={marker}
            active={activeKey === marker.annotation.key}
            open={open?.key === marker.annotation.key ? open : null}
            onOpenChange={(next) => {
              cancelClose();
              setOpen(next);
            }}
            onPopupHover={(hovering) => {
              popupHoveredRef.current = hovering;
              if (hovering) cancelClose();
              else closeTextPreviewSoon();
            }}
            onSave={(comment) => saveComment(marker.annotation, comment)}
            onRemove={() => remove(marker.annotation)}
          />
        ))}
      </div>,
      source,
      sourceMarkers[0]!.annotation.key,
    ),
  );
}

function AnnotationMarker({
  marker: { annotation, popElapsed, left, top },
  active,
  open,
  onOpenChange,
  onPopupHover,
  onSave,
  onRemove,
}: {
  marker: Marker;
  active: boolean;
  open: OpenState | null;
  onOpenChange: (open: OpenState | null) => void;
  onPopupHover: (hovering: boolean) => void;
  onSave: (comment: string) => boolean;
  onRemove: () => void;
}) {
  const gt = useGT();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const actionsRef = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const isOpen = open !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Base UI forgets a click open only when it closes itself; without this, hover never reopens a clicked marker
  useEffect(() => {
    if (!isOpen) actionsRef.current?.close();
  }, [isOpen]);
  const { citation, draftNumber, key, hue } = annotation;
  const owner = annotation.owner === HOST_NAME ? gt("Host") : annotation.owner;
  const isDraft = draftNumber !== null;
  // Only your own draft's citations edit; everyone else's are read-only.
  const editable = isDraft && owner === null;
  const comment = citation.comment?.trim();
  return (
    <Popover
      open={isOpen}
      actionsRef={actionsRef}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "imperative-action") return;
        if (!next)
          return onOpenChange(open?.editing && details.reason === "trigger-hover" ? open : null);
        const editing = editable && details.reason === "trigger-press";
        onOpenChange({ key, editing: editing || !!open?.editing, fromText: false });
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={80}
        closeDelay={140}
        aria-label={
          editable
            ? gt("Edit citation comment")
            : owner !== null
              ? gt("Cited by {name}", { name: owner })
              : gt("View cited assistant text: {label}", {
                  label: assistantCitationLabel(citation),
                })
        }
        render={
          <button
            type="button"
            data-annotation-marker={isDraft ? "draft" : "sent"}
            className={cn(
              "absolute z-1 inline-flex h-3.5 cursor-pointer items-center justify-center gap-px rounded-full font-semibold text-3xs leading-none tabular-nums ring-2 ring-background transition-[scale] duration-150 ease-out select-none focus-visible:outline-2 focus-visible:outline-ring data-active:scale-115 motion-safe:data-fresh:animate-annotation-pop [&_svg]:size-2 [&_svg]:fill-current",
              editable
                ? "bg-primary ps-1 pe-1.25 text-primary-foreground"
                : hue !== null && isDraft
                  ? "bg-(--annotation-peer) px-1 text-white"
                  : hue !== null
                    ? "bg-(--annotation-peer)/20 px-1 text-(--annotation-peer)"
                    : "bg-muted-foreground/15 px-1 text-muted-foreground",
            )}
            data-active={active || undefined}
            data-fresh={popElapsed !== null || undefined}
            style={{
              left,
              top,
              animationDelay: popElapsed ? `-${popElapsed}ms` : undefined,
              ...peerStyle(hue),
            }}
          />
        }
      >
        {owner === null ? (
          <QuoteIcon aria-hidden="true" />
        ) : (
          <span aria-hidden="true">{initialOf(owner)}</span>
        )}
        {draftNumber}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={6}
        width={open?.editing ? "md" : "sm"}
        padding="compact"
        initialFocus={open?.editing ? inputRef : false}
        finalFocus={false}
        data-annotation-popup=""
        onPointerEnter={() => onPopupHover(true)}
        onPointerLeave={() => onPopupHover(false)}
      >
        {open?.editing ? (
          <AssistantCitationCommentEditor
            citation={citation}
            inputRef={inputRef}
            onSubmit={onSave}
            onCancel={() => onOpenChange({ key, editing: false, fromText: false })}
          />
        ) : (
          <div className="flex items-start gap-2 text-sm">
            <div className="min-w-0 flex-1 py-0.5">
              {owner !== null ? (
                <p
                  className="flex items-center gap-1.5 text-muted-foreground text-xs"
                  style={peerStyle(hue)}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full bg-(--annotation-peer)"
                  />
                  {gt("Cited by {name}", { name: owner })}
                </p>
              ) : null}
              {comment || editable ? (
                <p
                  className={cn(
                    "whitespace-pre-wrap wrap-break-word",
                    !comment && "text-muted-foreground",
                  )}
                  dir="auto"
                >
                  {comment || gt("Add a comment")}
                </p>
              ) : null}
            </div>
            {editable ? (
              <div className="-me-1 flex shrink-0">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={gt("Edit citation comment")}
                  onClick={() => {
                    onOpenChange({ key, editing: true, fromText: false });
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  <PencilIcon aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={gt("Remove {name}", { name: assistantCitationLabel(citation) })}
                  onClick={onRemove}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
