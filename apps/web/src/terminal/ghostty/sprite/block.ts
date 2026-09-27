// Block Elements U+2580..U+259F, sextants U+1FB00..U+1FB3B, octants
// U+1CD00..U+1CDE5, and corner triangles from Geometric Shapes, ported from
// Ghostty `draw/block.zig`, `draw/symbols_for_legacy_computing*.zig`, and
// `draw/geometric_shapes.zig` (MIT).

import { fill, SHADE, type SpriteCanvas, type SpriteMetrics, thicknessPx } from "./canvas";

type Horizontal = "left" | "right";
type Vertical = "top" | "bottom";

function block(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
  horizontal: Horizontal,
  vertical: Vertical,
  widthFraction: number,
  heightFraction: number,
): void {
  const { cellWidth, cellHeight } = metrics;
  const width = Math.round(cellWidth * widthFraction);
  const height = Math.round(cellHeight * heightFraction);
  const x = horizontal === "left" ? 0 : cellWidth - width;
  const y = vertical === "top" ? 0 : cellHeight - height;
  canvas.rect(x, y, width, height);
}

function fullBlock(metrics: SpriteMetrics, canvas: SpriteCanvas, shade: number): void {
  canvas.box(0, 0, metrics.cellWidth, metrics.cellHeight, shade);
}

// Quadrant bits for U+2596..U+259F: 1 tl, 2 tr, 4 bl, 8 br.
const QUADRANTS = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14] as const;

function quadrants(metrics: SpriteMetrics, canvas: SpriteCanvas, bits: number): void {
  if (bits & 1) fill(metrics, canvas, 0, 0.5, 0, 0.5);
  if (bits & 2) fill(metrics, canvas, 0.5, 1, 0, 0.5);
  if (bits & 4) fill(metrics, canvas, 0, 0.5, 0.5, 1);
  if (bits & 8) fill(metrics, canvas, 0.5, 1, 0.5, 1);
}

export function drawBlock(codepoint: number, canvas: SpriteCanvas, metrics: SpriteMetrics): void {
  if (codepoint === 0x2580) return block(metrics, canvas, "left", "top", 1, 1 / 2);
  if (codepoint >= 0x2581 && codepoint <= 0x2587) {
    return block(metrics, canvas, "left", "bottom", 1, (codepoint - 0x2580) / 8);
  }
  if (codepoint === 0x2588) return fullBlock(metrics, canvas, SHADE.on);
  if (codepoint >= 0x2589 && codepoint <= 0x258f) {
    return block(metrics, canvas, "left", "top", (0x2590 - codepoint) / 8, 1);
  }
  switch (codepoint) {
    case 0x2590:
      return block(metrics, canvas, "right", "top", 1 / 2, 1);
    case 0x2591:
      return fullBlock(metrics, canvas, SHADE.light);
    case 0x2592:
      return fullBlock(metrics, canvas, SHADE.medium);
    case 0x2593:
      return fullBlock(metrics, canvas, SHADE.dark);
    case 0x2594:
      return block(metrics, canvas, "left", "top", 1, 1 / 8);
    case 0x2595:
      return block(metrics, canvas, "right", "top", 1 / 8, 1);
  }
  const quadrant = QUADRANTS[codepoint - 0x2596];
  if (quadrant !== undefined) quadrants(metrics, canvas, quadrant);
}

/** Two columns, `rows` rows; bit `2 * row + column` fills that piece. */
function mosaic(metrics: SpriteMetrics, canvas: SpriteCanvas, rows: number, bits: number): void {
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      if (bits & (1 << (row * 2 + column))) {
        fill(metrics, canvas, column / 2, (column + 1) / 2, row / rows, (row + 1) / rows);
      }
    }
  }
}

export function drawSextant(codepoint: number, canvas: SpriteCanvas, metrics: SpriteMetrics): void {
  // The block skips the patterns that already exist as half blocks.
  const index = codepoint - 0x1fb00;
  mosaic(metrics, canvas, 3, index + Math.floor(index / 0x14) + 1);
}

// Octant bitmask per codepoint from U+1CD00, generated from Ghostty's
// `octants.txt`; bit 0 is octant 1 (top left), read row by row.
const OCTANTS =
  "04060708090b0c0d0e1011121315161718191a1b1c1d1e1f2021222324252627" +
  "292a2b2c2d2e2f303132333435363738393a3b3c3d3e4142434445464748494a" +
  "4b4c4d4e4f51525354565758595b5c5d5e606162636465666768696a6b6c6d6e" +
  "6f707172737475767778797a7b7c7d7e7f8182838485868788898a8b8c8d8e8f" +
  "909192939495969798999a9b9c9d9e9fa1a2a3a4a6a7a8a9abacadaeb0b1b2b3" +
  "b4b5b6b7b8b9babbbcbdbebfc1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4" +
  "d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff1f2f3f4f6" +
  "f7f8f9fbfdfe";

export function drawOctant(codepoint: number, canvas: SpriteCanvas, metrics: SpriteMetrics): void {
  const offset = (codepoint - 0x1cd00) * 2;
  mosaic(metrics, canvas, 4, Number.parseInt(OCTANTS.slice(offset, offset + 2), 16));
}

type Corner = "tl" | "tr" | "bl" | "br";

function cornerTriangle(
  metrics: SpriteMetrics,
  corner: Corner,
): [number, number, number, number, number, number] {
  const { cellWidth: width, cellHeight: height } = metrics;
  switch (corner) {
    case "tl":
      return [0, 0, 0, height, width, 0];
    case "tr":
      return [0, 0, width, height, width, 0];
    case "bl":
      return [0, 0, 0, height, width, height];
    case "br":
      return [0, height, width, height, width, 0];
  }
}

const FILLED_CORNERS: Record<number, Corner> = {
  0x25e2: "br",
  0x25e3: "bl",
  0x25e4: "tl",
  0x25e5: "tr",
};

const OUTLINED_CORNERS: Record<number, Corner> = {
  0x25f8: "tl",
  0x25f9: "tr",
  0x25fa: "bl",
  0x25ff: "br",
};

export function drawCornerTriangle(
  codepoint: number,
  canvas: SpriteCanvas,
  metrics: SpriteMetrics,
): void {
  const filled = FILLED_CORNERS[codepoint];
  if (filled) {
    canvas.triangle(...cornerTriangle(metrics, filled));
    return;
  }
  const outlined = OUTLINED_CORNERS[codepoint];
  if (!outlined) return;
  const [x0, y0, x1, y1, x2, y2] = cornerTriangle(metrics, outlined);
  canvas.innerStrokePath(
    (path) => {
      path.moveTo(x0, y0);
      path.lineTo(x1, y1);
      path.lineTo(x2, y2);
      path.closePath();
    },
    thicknessPx("light", metrics.boxThickness),
  );
}
