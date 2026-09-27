/**
 * Fork: extra glyphs for the web context-menu fallback, keyed by the same
 * icon keyword the menu items carry. Upstream's inline table stays untouched;
 * the fallback merges these in at lookup time.
 */
export const forkIconPaths: Record<
  string,
  ReadonlyArray<{ tag: string; attrs: Record<string, string> }>
> = {
  // Lucide `arrow-down-up`: the sort glyph for Reset order.
  "arrow-down-up": [
    { tag: "path", attrs: { d: "m21 16-4 4-4-4" } },
    { tag: "path", attrs: { d: "M17 20V4" } },
    { tag: "path", attrs: { d: "m3 8 4-4 4 4" } },
    { tag: "path", attrs: { d: "M7 4v16" } },
  ],
  // Lucide `git-fork`: the glyph for Fork thread.
  "git-fork": [
    { tag: "circle", attrs: { cx: "12", cy: "18", r: "3" } },
    { tag: "circle", attrs: { cx: "6", cy: "6", r: "3" } },
    { tag: "circle", attrs: { cx: "18", cy: "6", r: "3" } },
    { tag: "path", attrs: { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" } },
    { tag: "path", attrs: { d: "M12 12v3" } },
  ],
};
