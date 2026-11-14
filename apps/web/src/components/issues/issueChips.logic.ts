/**
 * A label carries the repository's own GitHub hex and an issue type carries GitHub's named swatch,
 * so the palette on screen is GitHub's rather than one this app invented. Both are painted by the
 * pull request label chip, which owns the per-theme legibility; this module only resolves a type's
 * named colour to hex and gives a plainly named type its glyph.
 */

/** GitHub names an issue type's colour instead of sending hex. These are its own swatches. */
const ISSUE_TYPE_HEX: Record<string, string> = {
  RED: "d1242f",
  ORANGE: "bc4c00",
  YELLOW: "9a6700",
  GREEN: "1a7f37",
  BLUE: "0969da",
  PURPLE: "8250df",
  PINK: "bf3989",
  GRAY: "59636e",
};

/**
 * The glyph for a type whose name does not already carry one. A workspace that names its types
 * plainly still gets the same shorthand the fork's own tracker uses.
 */
const ISSUE_TYPE_EMOJI: Record<string, string> = {
  bug: "🐛",
  feature: "✨",
  task: "🔨",
  tracker: "📡",
  slice: "🍰",
  project: "🧭",
};

/** A name that already pictures itself, such as `Bug 🐛`, needs no glyph adding. */
const NAME_GLYPH = /[\p{Extended_Pictographic}️]/u;

/** Resolves either colour form to hex, so a type and a label can share one chip style. */
export function gitHubIssueTypeHexColor(color: string | null): string | null {
  if (color === null) return null;
  return ISSUE_TYPE_HEX[color.trim().toUpperCase()] ?? color;
}

/** The type's name as GitHub sent it, with a glyph added only when it has none of its own. */
export function gitHubIssueTypeLabel(name: string): string {
  const trimmed = name.trim();
  if (NAME_GLYPH.test(trimmed)) return trimmed;
  const emoji = ISSUE_TYPE_EMOJI[trimmed.toLowerCase()];
  return emoji === undefined ? trimmed : `${trimmed} ${emoji}`;
}
