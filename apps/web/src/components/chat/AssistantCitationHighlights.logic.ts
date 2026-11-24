import type { AssistantCitation } from "@t3tools/contracts";

type Rect = Pick<DOMRectReadOnly, "left" | "top" | "right" | "width">;

export const passageKey = ({ messageId, start, end }: AssistantCitation) =>
  `${messageId}:${start}:${end}`;

/**
 * The draft's citations, then each other passage that sent messages cite, once, as last sent.
 * A passage the draft cites again shows as the draft's.
 */
export function citedPassages<T extends { citation: AssistantCitation }>(
  drafts: ReadonlyArray<T>,
  sent: ReadonlyArray<T>,
): T[] {
  const seen = new Set(drafts.map(({ citation }) => passageKey(citation)));
  const latest = sent.toReversed().filter(({ citation }) => {
    const key = passageKey(citation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...drafts, ...latest.toReversed()];
}

/** Size of one `❝n` marker in rem, matching its badge's `h-3.5`; each digit of `n` widens it. */
const MARKER_HEIGHT = 0.875;
const MARKER_BASE_WIDTH = 1.25;
const MARKER_DIGIT_WIDTH = 0.375;
const MARKER_GAP = 0.125;

/**
 * Where each cited passage's marker sits inside its source: just past the end of its last line,
 * riding the line's top edge, since an overlay cannot reflow the text around it.
 * `rem` is the root font size in pixels, which the badges scale with.
 */
export function placeCitationMarkers(
  ends: ReadonlyArray<{ source: string; line: Rect; bounds: Rect; digits: number }>,
  rem = 16,
): Array<{ left: number; top: number }> {
  const height = MARKER_HEIGHT * rem;
  const gap = MARKER_GAP * rem;
  const spots = ends.map(({ source, line, bounds, digits }) => {
    const left = Math.round(line.right - bounds.left + 1);
    const top = Math.round(line.top - bounds.top - height / 2);
    const marker = (MARKER_BASE_WIDTH + digits * MARKER_DIGIT_WIDTH) * rem;
    return { key: `${source}:${left}:${top}`, left, top, width: bounds.width, marker };
  });
  const rows = new Map<string, number>();
  for (const { key, marker } of spots) {
    rows.set(key, (rows.get(key) ?? -gap) + gap + marker);
  }
  const cursors = new Map<string, { x: number; y: number }>();
  return spots.map(({ key, left, top, width, marker }) => {
    // A passage cited more than once ends at one spot: its markers sit side by side, the row
    // slides left rather than cross the lane edge, and wraps below once the lane is full.
    const cursor = cursors.get(key) ?? {
      x: Math.max(0, Math.min(left, width - rows.get(key)!)),
      y: top,
    };
    if (cursor.x > 0 && cursor.x + marker > width) {
      cursor.x = 0;
      cursor.y += height + gap;
    }
    const spot = { left: Math.round(cursor.x), top: Math.round(cursor.y) };
    cursor.x += marker + gap;
    cursors.set(key, cursor);
    return spot;
  });
}
