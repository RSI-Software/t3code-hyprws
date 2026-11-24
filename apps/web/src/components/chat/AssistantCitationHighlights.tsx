import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { useEffect } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

const DRAFT_HIGHLIGHT_NAME = "t3-assistant-citation-draft";

/** Swaps one owner's ranges in the shared draft highlight, registering it only while it has any. */
function replaceDraftRanges(previous: ReadonlyArray<Range>, next: ReadonlyArray<Range>) {
  const highlight = CSS.highlights.get(DRAFT_HIGHLIGHT_NAME) ?? new Highlight();
  for (const range of previous) highlight.delete(range);
  for (const range of next) highlight.add(range);
  if (highlight.size > 0) CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, highlight);
  else CSS.highlights.delete(DRAFT_HIGHLIGHT_NAME);
}

/** Tints the passages the composer draft cites, without touching the rendered markdown. */
export function AssistantCitationHighlights({
  viewport,
  draftTarget,
}: {
  viewport: HTMLElement | null;
  draftTarget: ComposerThreadTarget;
}) {
  // The citations' own markdown, so typing elsewhere in the draft does not re-render.
  const citationsKey = useComposerDraftStore((store) =>
    collectAssistantCitations(store.getComposerDraft(draftTarget)?.prompt ?? "")
      .map(({ source }) => source)
      .join(" "),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints CSS Highlight ranges over rendered markdown and repaints when cited rows mount or change
  useEffect(() => {
    const citations = collectAssistantCitations(citationsKey);
    if (!viewport || citations.length === 0) return;
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    const cited = citations
      .map(({ citation }) => `[data-assistant-citation-source="${CSS.escape(citation.messageId)}"]`)
      .join();
    const isCited = (node: Node) =>
      node instanceof Element && (node.matches(cited) || node.querySelector(cited) !== null);
    let painted: Range[] = [];
    let frame: number | null = null;
    const paint = () => {
      frame = null;
      const next = citations.flatMap(
        ({ citation }) => findAssistantCitationSourceAnchor(viewport, citation)?.range ?? [],
      );
      replaceDraftRanges(painted, next);
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
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    paint();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      replaceDraftRanges(painted, []);
    };
  }, [viewport, citationsKey]);

  return null;
}
