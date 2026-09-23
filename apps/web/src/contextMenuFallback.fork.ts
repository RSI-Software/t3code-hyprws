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
};
