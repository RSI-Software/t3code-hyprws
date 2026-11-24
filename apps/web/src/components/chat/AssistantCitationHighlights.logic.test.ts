import type { AssistantCitation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { citedPassages, placeCitationMarkers } from "./AssistantCitationHighlights.logic";

const bounds = { left: 100, top: 50, right: 300, width: 200 };
const lineEndingAt = (right: number, top = 70) => ({ left: 100, top, right, width: right - 100 });
const end = (source: string, right: number, digits = 1) => ({
  source,
  line: lineEndingAt(right),
  bounds,
  digits,
});

describe("placeCitationMarkers", () => {
  it("puts a marker past its passage's last line, on the line's top edge", () => {
    expect(placeCitationMarkers([end("a", 180)])).toEqual([{ left: 81, top: 13 }]);
  });

  it("sets a passage cited twice side by side, apart from other passages, by digit count", () => {
    expect(
      placeCitationMarkers([end("a", 180), end("b", 180), end("a", 180, 2), end("a", 180)]),
    ).toEqual([
      { left: 81, top: 13 },
      { left: 81, top: 13 },
      { left: 109, top: 13 },
      { left: 143, top: 13 },
    ]);
  });

  it("scales markers with the root font size", () => {
    expect(placeCitationMarkers([end("a", 180), end("a", 180)], 20)).toEqual([
      { left: 81, top: 11 },
      { left: 116, top: 11 },
    ]);
  });

  it("slides a row of markers left so it stays inside the lane", () => {
    const last = end("a", 290);
    expect(placeCitationMarkers([last, last, last]).map(({ left }) => left)).toEqual([
      118, 146, 174,
    ]);
    const narrow = { ...last, bounds: { ...bounds, width: 40 } };
    expect(placeCitationMarkers([narrow])).toEqual([{ left: 14, top: 13 }]);
  });

  it("wraps a row wider than its lane onto the next line", () => {
    const narrow = { ...end("a", 290), bounds: { ...bounds, width: 60 } };
    expect(placeCitationMarkers([narrow, narrow, narrow])).toEqual([
      { left: 0, top: 13 },
      { left: 28, top: 13 },
      { left: 0, top: 29 },
    ]);
  });
});

describe("citedPassages", () => {
  const cite = (start: number, comment: string) => ({
    comment,
    citation: { messageId: "m", start, end: start + 4 } as AssistantCitation,
  });

  it("keeps the draft's citations, then each sent passage once, as last sent", () => {
    expect(
      citedPassages(
        [cite(0, "draft")],
        [cite(10, "first"), cite(0, "sent"), cite(20, "only"), cite(10, "again")],
      ).map(({ comment }) => comment),
    ).toEqual(["draft", "only", "again"]);
  });
});
