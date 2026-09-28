// The window title names the window's project filter
// (RSI-Software/t3code-hyprws#1353), presentation only. The renderer composes
// `<app> — <filter>`; the desktop hub window keeps its own app name and takes
// only the filter part, so the web and desktop names never mix.

const FILTER_SEPARATOR = " — ";

/** `base` with the filter label appended; `base` alone for all projects. */
export function composeFilteredWindowTitle(base: string, filterLabel: string | null): string {
  return filterLabel === null || filterLabel.length === 0
    ? base
    : `${base}${FILTER_SEPARATOR}${filterLabel}`;
}

/**
 * The hub window's filtered title: its own app name plus the page's filter
 * label. `null` when the page carries no label or the window is not the hub,
 * which leaves upstream's title in place.
 */
export function hubFilterTitleFork(
  windowKind: string,
  displayName: string,
  pageTitle: string,
): string | null {
  if (windowKind !== "hub") return null;
  const at = pageTitle.indexOf(FILTER_SEPARATOR);
  const label = at < 0 ? "" : pageTitle.slice(at + FILTER_SEPARATOR.length).trim();
  return label.length === 0 ? null : composeFilteredWindowTitle(displayName, label);
}
