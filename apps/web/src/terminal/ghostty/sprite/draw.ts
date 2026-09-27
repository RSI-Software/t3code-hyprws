// Ghostty draws box drawing, blocks, Braille, Powerline, and legacy-computing
// mosaics itself instead of taking them from the font, so they fill the cell
// edge to edge at any line height and tile without seams. This module ports
// that sprite font (ghostty-org/ghostty `src/font/sprite`, MIT) to canvas 2D.

import { GHOSTTY_CELL_WIDE, type GhosttyCell } from "../core";
import { drawBlock, drawCornerTriangle, drawOctant, drawSextant } from "./block";
import { drawBox } from "./box";
import { drawBraille } from "./braille";
import { SpriteCanvas, type SpriteMetrics } from "./canvas";
import { drawPowerline } from "./powerline";

type SpriteDraw = (codepoint: number, canvas: SpriteCanvas, metrics: SpriteMetrics) => void;

const SPRITE_RANGES: ReadonlyArray<readonly [number, number, SpriteDraw]> = [
  [0x2500, 0x257f, drawBox],
  [0x2580, 0x259f, drawBlock],
  [0x25e2, 0x25e5, drawCornerTriangle],
  [0x25f8, 0x25fa, drawCornerTriangle],
  [0x25ff, 0x25ff, drawCornerTriangle],
  [0x2800, 0x28ff, drawBraille],
  [0xe0b0, 0xe0bf, drawPowerline],
  [0xe0d2, 0xe0d2, drawPowerline],
  [0xe0d4, 0xe0d4, drawPowerline],
  [0x1cd00, 0x1cde5, drawOctant],
  [0x1fb00, 0x1fb3b, drawSextant],
];

// Ghostty's box stroke is the face's underline thickness, which canvas cannot
// read; 1/20 em matches the common monospace faces.
const BOX_THICKNESS_EM = 0.05;

function spriteDrawFor(codepoint: number): SpriteDraw | null {
  if (codepoint < 0x2500) return null;
  for (const [start, end, draw] of SPRITE_RANGES) {
    if (codepoint >= start && codepoint <= end) return draw;
  }
  return null;
}

/**
 * The codepoint when a cell's text is exactly one sprite glyph, else null.
 * Runs for every drawn cell, so it stays allocation-free.
 */
export function ghosttySpriteCodepoint(text: string): number | null {
  const codepoint = text.codePointAt(0);
  // Exactly one codepoint; anything longer carries combining marks.
  if (codepoint === undefined || text.length !== (codepoint > 0xffff ? 2 : 1)) return null;
  return spriteDrawFor(codepoint) ? codepoint : null;
}

/** Columns a cell covers: two when a wide spacer tail follows it. */
export function ghosttyCellSpan(cells: readonly GhosttyCell[], column: number): number {
  return cells[column + 1]?.wide === GHOSTTY_CELL_WIDE.spacerTail ? 2 : 1;
}

/**
 * A user-space cell rect snapped to whole device pixels. Both edges round, so
 * adjacent cells share their edges and nothing is left half-covered.
 */
function snapToDevice(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const { a: scaleX, d: scaleY, e: offsetX, f: offsetY } = context.getTransform();
  const x = Math.round(scaleX * left + offsetX);
  const y = Math.round(scaleY * top + offsetY);
  const deviceWidth = Math.round(scaleX * (left + width) + offsetX) - x;
  const deviceHeight = Math.round(scaleY * (top + height) + offsetY) - y;
  return deviceWidth > 0 && deviceHeight > 0
    ? { x, y, width: deviceWidth, height: deviceHeight, scaleY }
    : null;
}

/**
 * `fillRect` in the current fill style, snapped to the device grid sprites use.
 * A fractional edge would blend one pixel line into a snapped neighbour.
 */
export function fillGhosttyCellRect(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const snapped = snapToDevice(context, left, top, width, height);
  if (!snapped) return;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillRect(snapped.x, snapped.y, snapped.width, snapped.height);
  context.restore();
}

/**
 * Draw a sprite glyph into a cell rect given in the context's current user
 * space. The cell is snapped to whole device pixels so each glyph is drawn on
 * the same integer grid Ghostty uses, and adjacent cells share their edges.
 */
export function drawGhosttySprite(
  context: CanvasRenderingContext2D,
  codepoint: number,
  left: number,
  top: number,
  cellWidth: number,
  cellHeight: number,
  color: string,
  fontSize: number,
): void {
  const draw = spriteDrawFor(codepoint);
  const snapped = draw ? snapToDevice(context, left, top, cellWidth, cellHeight) : null;
  if (!draw || !snapped) return;
  const { x, y, width, height, scaleY } = snapped;

  context.save();
  context.setTransform(1, 0, 0, 1, x, y);
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.fillStyle = color;
  context.strokeStyle = color;
  draw(codepoint, new SpriteCanvas(context, width, height), {
    cellWidth: width,
    cellHeight: height,
    boxThickness: Math.max(1, Math.ceil(fontSize * scaleY * BOX_THICKNESS_EM)),
  });
  context.restore();
}
