import { describe, expect, it } from "vite-plus/test";

import {
  gitHubChipInk,
  gitHubChipVars,
  gitHubIssueTypeHexColor,
  gitHubIssueTypeLabel,
  parseGitHubHexColor,
} from "./githubIssueChips.logic";

const PAPER = { r: 255, g: 255, b: 255 };
const INK = { r: 12, g: 15, b: 24 };

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(
  left: { r: number; g: number; b: number },
  right: { r: number; g: number; b: number },
): number {
  const one = luminance(left);
  const other = luminance(right);
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

describe("GitHub issue chips", () => {
  it.each(["1d76db", "#1d76db", " 1D76DB "])("reads GitHub's hex form %s", (color) => {
    expect(parseGitHubHexColor(color)).toStrictEqual({ r: 29, g: 118, b: 219 });
  });

  it.each([null, undefined, "", "rebeccapurple", "12345"])(
    "has no colour for %s, which leaves the chip monochrome",
    (color) => {
      expect(parseGitHubHexColor(color)).toBeNull();
      expect(gitHubChipVars(color)).toBeUndefined();
    },
  );

  it.each(["d4c5f9", "ffffff", "0e1116", "1d76db", "fbca04"])(
    "keeps %s legible on both themes",
    (color) => {
      const parsed = parseGitHubHexColor(color);
      expect(parsed).not.toBeNull();
      if (parsed === null) return;
      expect(contrast(gitHubChipInk(parsed, PAPER), PAPER)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(gitHubChipInk(parsed, INK), INK)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("leaves a colour that already reads on the theme untouched, so the hue survives", () => {
    expect(gitHubChipInk({ r: 13, g: 60, b: 120 }, PAPER)).toStrictEqual({ r: 13, g: 60, b: 120 });
  });

  it("hands both themes over as custom properties rather than deciding one here", () => {
    const vars = gitHubChipVars("d4c5f9") as Record<string, string> | undefined;
    expect(Object.keys(vars ?? {})).toStrictEqual(["--gh-chip-light", "--gh-chip-dark"]);
    // A pale lilac cannot stay itself on paper, and has no reason to move in the dark.
    expect(vars?.["--gh-chip-light"]).not.toBe("rgb(212 197 249)");
    expect(vars?.["--gh-chip-dark"]).toBe("rgb(212 197 249)");
  });

  it("maps an issue type's colour name to hex and passes hex through", () => {
    expect(gitHubIssueTypeHexColor("RED")).toBe("d1242f");
    expect(gitHubIssueTypeHexColor("1d76db")).toBe("1d76db");
    expect(gitHubIssueTypeHexColor(null)).toBeNull();
  });

  it("adds a glyph only to a type that has none of its own", () => {
    expect(gitHubIssueTypeLabel("Bug 🐛")).toBe("Bug 🐛");
    expect(gitHubIssueTypeLabel("Bug")).toBe("Bug 🐛");
    expect(gitHubIssueTypeLabel("Tracker")).toBe("Tracker 📡");
    expect(gitHubIssueTypeLabel("Chore")).toBe("Chore");
  });
});
