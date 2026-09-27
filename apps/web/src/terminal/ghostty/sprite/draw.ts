// Ghostty draws box drawing, blocks, Braille, Powerline, branch, and
// legacy-computing glyphs itself instead of taking them from the font, so they
// fill the cell edge to edge at any line height and tile without seams. Its
// own sprite rasterizer (ghostty-org/ghostty `src/font/sprite`, MIT) ships as
// ghostty-sprite.wasm; this module draws its coverage masks onto the canvas.

import spriteWasmUrl from "../vendor/ghostty-sprite.wasm?url";
import { GHOSTTY_CELL_WIDE, type GhosttyCell, type GhosttyColor } from "../core";

interface SpriteExports {
  readonly memory: WebAssembly.Memory;
  readonly t3_sprite_has: (codepoint: number) => number;
  readonly t3_sprite_render: (
    codepoint: number,
    cellWidth: number,
    cellHeight: number,
    thickness: number,
    span: number,
  ) => number;
}

interface SpriteShape {
  /** Coverage as one path per distinct alpha, so any colour fills it directly. */
  readonly paths: ReadonlyArray<readonly [alpha: number, path: Path2D]>;
  /** Cell-sized coverage, kept only for shapes too intricate to fill quickly. */
  readonly mask: Uint8Array | null;
  readonly tints: Map<number, OffscreenCanvas>;
}

// Ghostty's box stroke is the face's underline thickness, which canvas cannot
// read; 1/20 em matches the common monospace faces.
const BOX_THICKNESS_EM = 0.05;
// Box, block, and Braille shapes are a few rects and fill fastest as paths;
// antialiased diagonals and curves blit faster as a tinted image.
const MAX_PATH_RECTS = 8;
// Truecolor makes the colour axis unbounded, so past this budget intricate
// shapes fill their paths instead of tinting another image.
const MAX_TINTED_SPRITES = 1024;
// Font size and display scale changes add shapes; the cache starts over past this.
const MAX_SHAPES = 4096;

let face: SpriteExports | null = null;
let loading: Promise<void> | null = null;
const shapes = new Map<number, SpriteShape | null>();
let tintedSprites = 0;

/**
 * Loads the sprite rasterizer. Never rejects: until it resolves, or when it
 * fails, sprite codepoints fall back to the font.
 */
export function loadGhosttySprites(): Promise<void> {
  if (typeof OffscreenCanvas !== "function" || typeof Path2D !== "function") {
    return Promise.resolve();
  }
  loading ??= (async () => {
    const response = await fetch(spriteWasmUrl);
    if (!response.ok) throw new Error(`Unable to load ghostty-sprite.wasm (${response.status})`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
    const exports = instance.exports as Partial<SpriteExports>;
    if (
      !(exports.memory instanceof WebAssembly.Memory) ||
      typeof exports.t3_sprite_has !== "function" ||
      typeof exports.t3_sprite_render !== "function"
    ) {
      throw new Error("ghostty-sprite.wasm is missing its exports");
    }
    face = exports as SpriteExports;
  })().catch((error: unknown) => {
    loading = null;
    console.warn("[ghostty-sprite] drawing sprite glyphs from the font instead", error);
  });
  return loading;
}

/**
 * The codepoint when a cell's text is exactly one sprite glyph, else null.
 * Runs for every drawn cell, so it stays allocation-free.
 */
export function ghosttySpriteCodepoint(text: string): number | null {
  const codepoint = text.codePointAt(0);
  // Exactly one codepoint; anything longer carries combining marks.
  if (codepoint === undefined || text.length !== (codepoint > 0xffff ? 2 : 1)) return null;
  // Every sprite sits at or above U+2500, so plain text never crosses into wasm.
  return codepoint >= 0x2500 && face?.t3_sprite_has(codepoint) ? codepoint : null;
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

// Ghostty renders into a padded canvas, and a few diagonals antialias a pixel
// into it. Rows here redraw independently, so only the cell itself is kept.
function renderMask(
  sprites: SpriteExports,
  codepoint: number,
  width: number,
  height: number,
  thickness: number,
): Uint8Array | null {
  const pointer = sprites.t3_sprite_render(codepoint, width, height, thickness, 1);
  if (pointer === 0) return null;
  const padX = Math.floor(width / 4);
  const padY = Math.floor(height / 4);
  const stride = width + 2 * padX;
  const padded = new Uint8Array(sprites.memory.buffer, pointer, stride * (height + 2 * padY));
  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const start = (padY + row) * stride + padX;
    mask.set(padded.subarray(start, start + width), row * width);
  }
  return mask;
}

function tintMask(
  mask: Uint8Array,
  width: number,
  height: number,
  color: GhosttyColor,
): OffscreenCanvas | null {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(width, height);
  for (let index = 0; index < mask.length; index += 1) {
    image.data[index * 4] = color.r;
    image.data[index * 4 + 1] = color.g;
    image.data[index * 4 + 2] = color.b;
    image.data[index * 4 + 3] = mask[index]!;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Coverage as rects: runs of equal alpha along each row, extended downward
 * while the next row repeats them. Flat [x, y, width, height, alpha] tuples.
 */
function coverageRects(mask: Uint8Array, width: number, height: number): number[] {
  const rects: number[] = [];
  let above: number[] = [];
  for (let row = 0; row < height; row += 1) {
    const current: number[] = [];
    let column = 0;
    while (column < width) {
      const alpha = mask[row * width + column]!;
      let end = column + 1;
      while (end < width && mask[row * width + end] === alpha) end += 1;
      if (alpha !== 0) {
        const run = above.find(
          (index) =>
            rects[index] === column &&
            rects[index + 2] === end - column &&
            rects[index + 4] === alpha,
        );
        if (run === undefined) {
          current.push(rects.length);
          rects.push(column, row, end - column, 1, alpha);
        } else {
          rects[run + 3]! += 1;
          current.push(run);
        }
      }
      column = end;
    }
    above = current;
  }
  return rects;
}

function spriteShape(
  sprites: SpriteExports,
  codepoint: number,
  width: number,
  height: number,
  thickness: number,
): SpriteShape | null {
  // The numeric key packs 12 bits per dimension; no real cell comes close.
  if (width >= 4096 || height >= 4096) return null;
  const key = ((codepoint * 4096 + width) * 4096 + height) * 64 + Math.min(thickness, 63);
  const cached = shapes.get(key);
  if (cached !== undefined) return cached;
  if (shapes.size >= MAX_SHAPES) {
    shapes.clear();
    tintedSprites = 0;
  }
  const mask = renderMask(sprites, codepoint, width, height, thickness);
  let shape: SpriteShape | null = null;
  if (mask) {
    const rects = coverageRects(mask, width, height);
    const paths = new Map<number, Path2D>();
    for (let index = 0; index < rects.length; index += 5) {
      const alpha = rects[index + 4]!;
      let path = paths.get(alpha);
      if (!path) paths.set(alpha, (path = new Path2D()));
      path.rect(rects[index]!, rects[index + 1]!, rects[index + 2]!, rects[index + 3]!);
    }
    shape = {
      paths: [...paths],
      mask: rects.length > MAX_PATH_RECTS * 5 ? mask : null,
      tints: new Map(),
    };
  }
  shapes.set(key, shape);
  return shape;
}

function tintedImage(
  shape: SpriteShape,
  width: number,
  height: number,
  color: GhosttyColor,
): OffscreenCanvas | null {
  if (!shape.mask) return null;
  const rgb = (color.r << 16) | (color.g << 8) | color.b;
  const cached = shape.tints.get(rgb);
  if (cached || tintedSprites >= MAX_TINTED_SPRITES) return cached ?? null;
  const image = tintMask(shape.mask, width, height, color);
  if (image) {
    shape.tints.set(rgb, image);
    tintedSprites += 1;
  }
  return image;
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
  color: GhosttyColor,
  fontSize: number,
): void {
  const snapped = face ? snapToDevice(context, left, top, cellWidth, cellHeight) : null;
  if (!face || !snapped) return;
  const { x, y, width, height, scaleY } = snapped;
  const thickness = Math.max(1, Math.ceil(fontSize * scaleY * BOX_THICKNESS_EM));
  const shape = spriteShape(face, codepoint, width, height, thickness);
  if (!shape) return;
  const image = tintedImage(shape, width, height, color);
  context.save();
  context.setTransform(1, 0, 0, 1, x, y);
  if (image) {
    context.drawImage(image, 0, 0);
  } else {
    context.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    for (const [alpha, path] of shape.paths) {
      context.globalAlpha = alpha / 255;
      context.fill(path);
    }
  }
  context.restore();
}
