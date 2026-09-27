// Braille Patterns U+2800..U+28FF, ported from Ghostty `draw/braille.zig` (MIT).

import type { SpriteCanvas, SpriteMetrics } from "./canvas";

// Dot for each pattern bit, as [column, row]: bits 0-2 and 6 are the left
// column top to bottom, bits 3-5 and 7 the right.
const DOTS = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [1, 2],
  [0, 3],
  [1, 3],
] as const;

export function drawBraille(codepoint: number, canvas: SpriteCanvas, metrics: SpriteMetrics): void {
  const { cellWidth: width, cellHeight: height } = metrics;
  let dot = Math.min(Math.floor(width / 4), Math.floor(height / 8));
  let xSpacing = Math.floor(width / 4);
  let ySpacing = Math.floor(height / 8);
  let xMargin = Math.floor(xSpacing / 2);
  let yMargin = Math.floor(ySpacing / 2);
  let xLeft = width - 2 * xMargin - xSpacing - 2 * dot;
  let yLeft = height - 2 * yMargin - 3 * ySpacing - 4 * dot;

  // Spend leftover pixels in Ghostty's order: a visible dot, then margins,
  // then spacing, then more margin, then a bigger dot.
  if (xLeft >= 2 && yLeft >= 4 && dot === 0) {
    dot += 1;
    xLeft -= 2;
    yLeft -= 4;
  }
  if (xLeft >= 2 && xMargin === 0) {
    xMargin = 1;
    xLeft -= 2;
  }
  if (yLeft >= 2 && yMargin === 0) {
    yMargin = 1;
    yLeft -= 2;
  }
  if (xLeft >= 1) {
    xSpacing += 1;
    xLeft -= 1;
  }
  if (yLeft >= 3) {
    ySpacing += 1;
    yLeft -= 3;
  }
  if (xLeft >= 2) {
    xMargin += 1;
    xLeft -= 2;
  }
  if (yLeft >= 2) {
    yMargin += 1;
    yLeft -= 2;
  }
  if (xLeft >= 2 && yLeft >= 4) dot += 1;

  const pattern = codepoint - 0x2800;
  for (let bit = 0; bit < DOTS.length; bit += 1) {
    if (!(pattern & (1 << bit))) continue;
    const [column, row] = DOTS[bit]!;
    const x = xMargin + column * (dot + xSpacing);
    const y = yMargin + row * (dot + ySpacing);
    canvas.box(x, y, x + dot, y + dot);
  }
}
