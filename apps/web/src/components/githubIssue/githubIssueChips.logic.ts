import type { CSSProperties } from "react";

/**
 * A label carries the repository's own GitHub hex and an issue type carries GitHub's named swatch,
 * so the palette on screen is GitHub's rather than one this app invented. What differs is the
 * treatment: painting that hex as a solid fill is GitHub's light-mode label, and it shouts in a
 * dark UI. The chip instead makes the colour the *ink*, tints the fill from it, and nudges the ink
 * per theme until it is legible, which is the calmer half of what GitHub itself does after dark.
 */

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The two page backgrounds a chip must stay readable on. Near-black rather than pure black. */
const INK: Rgb = { r: 12, g: 15, b: 24 };
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/** WCAG AA for small text. A chip that cannot reach it keeps stepping until it is out of room. */
const TARGET_CONTRAST = 4.5;

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

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
/** A name that already pictures itself, such as `Bug 🐛`, needs no glyph adding. */
const NAME_GLYPH = /[\p{Extended_Pictographic}️]/u;

export function parseGitHubHexColor(color: string | null | undefined): Rgb | null {
  const match = HEX.exec(color?.trim() ?? "");
  if (match?.[1] === undefined) return null;
  const digits =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : match[1];
  const value = Number.parseInt(digits, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** Resolves either colour form to hex, so a type and a label can share one chip style. */
export function gitHubIssueTypeHexColor(color: string | null): string | null {
  if (color === null) return null;
  return ISSUE_TYPE_HEX[color.trim().toUpperCase()] ?? color;
}

function channelLuminance(channel: number): number {
  const ratio = channel / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrastRatio(left: Rgb, right: Rgb): number {
  const one = relativeLuminance(left);
  const other = relativeLuminance(right);
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const channel = (start: number, end: number) => Math.round(start + (end - start) * amount);
  return { r: channel(from.r, to.r), g: channel(from.g, to.g), b: channel(from.b, to.b) };
}

/**
 * The colour walked toward the far end of the theme until it reads on that theme's background.
 * A GitHub label is often a pastel chosen to be a background, so on paper it is darkened and in
 * the dark it is lightened; a colour already legible is returned untouched, hue intact.
 */
export function gitHubChipInk(color: Rgb, background: Rgb): Rgb {
  const toward = relativeLuminance(background) > 0.5 ? INK : PAPER;
  for (let amount = 0; amount <= 1; amount += 0.05) {
    const candidate = mix(color, toward, amount);
    if (contrastRatio(candidate, background) >= TARGET_CONTRAST) return candidate;
  }
  return toward;
}

const rgb = ({ r, g, b }: Rgb) => `rgb(${r} ${g} ${b})`;

/**
 * The chip's per-theme ink, or `undefined` when GitHub sent no usable colour and the caller should
 * fall back to its monochrome classes. Both themes are resolved here and handed over as custom
 * properties, so the chip's own `dark:` variant picks one without this module knowing the theme.
 */
export function gitHubChipVars(color: string | null | undefined): CSSProperties | undefined {
  const parsed = parseGitHubHexColor(color);
  if (parsed === null) return undefined;
  return {
    "--gh-chip-light": rgb(gitHubChipInk(parsed, PAPER)),
    "--gh-chip-dark": rgb(gitHubChipInk(parsed, INK)),
  } as CSSProperties;
}

/** The type's name as GitHub sent it, with a glyph added only when it has none of its own. */
export function gitHubIssueTypeLabel(name: string): string {
  const trimmed = name.trim();
  if (NAME_GLYPH.test(trimmed)) return trimmed;
  const emoji = ISSUE_TYPE_EMOJI[trimmed.toLowerCase()];
  return emoji === undefined ? trimmed : `${trimmed} ${emoji}`;
}
