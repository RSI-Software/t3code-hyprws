import { describe, expect, it } from "vite-plus/test";

import type { GhosttyCell, GhosttySnapshot } from "./core";
import { type GhosttyCellMetrics, renderGhosttySnapshot } from "./renderer";

const WHITE = "rgb(255, 255, 255)";
const BLACK = "rgb(0, 0, 0)";
const CURSOR = "rgb(200, 200, 200)";

const cell = (text: string, overrides: Partial<GhosttyCell> = {}): GhosttyCell => ({
  text,
  wide: 0,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
  ...overrides,
});

interface Fill {
  readonly style: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface AxisTransform {
  readonly a: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** Style of the last fill that touches device pixel (x, y), even partly. */
function paintAt(fills: readonly Fill[], x: number, y: number): string | undefined {
  return fills.findLast(
    (fill) =>
      x + 1 > fill.x && x < fill.x + fill.width && y + 1 > fill.y && y < fill.y + fill.height,
  )?.style;
}

/** Renders one frame and records every fill in device pixels. */
function render(
  rows: GhosttyCell[][],
  options: {
    readonly cursorX?: number;
    readonly scale?: number;
    readonly metrics?: GhosttyCellMetrics;
    readonly originY?: number;
  } = {},
) {
  const scale = options.scale ?? 1;
  const cursorX = options.cursorX ?? -1;
  const fills: Fill[] = [];
  const texts: string[] = [];
  let fillStyle = "";
  let current: AxisTransform = { a: scale, d: scale, e: 0, f: 0 };
  const stack: AxisTransform[] = [];
  const context = {
    canvas: { width: 400, height: 200 },
    getTransform: () => current,
    setTransform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => {
      current = { a, d, e, f };
    },
    save: () => stack.push(current),
    restore: () => {
      current = stack.pop() ?? current;
    },
    fillRect: (x: number, y: number, width: number, height: number) =>
      fills.push({
        style: fillStyle,
        x: current.a * x + current.e,
        y: current.d * y + current.f,
        width: current.a * width,
        height: current.d * height,
      }),
    fillText: (text: string) => texts.push(text),
    beginPath: () => {},
    clip: () => {},
    rect: () => {},
    resetTransform: () => {},
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
    },
    set strokeStyle(_value: string) {},
    set font(_value: string) {},
    set textBaseline(_value: string) {},
  } as unknown as CanvasRenderingContext2D;
  const snapshot: GhosttySnapshot = {
    cols: rows[0]?.length ?? 0,
    rows: rows.length,
    foreground: { r: 255, g: 255, b: 255 },
    background: { r: 0, g: 0, b: 0 },
    cursor: { r: 200, g: 200, b: 200 },
    cursorX,
    cursorY: cursorX >= 0 ? 0 : -1,
    cursorVisible: cursorX >= 0,
    cursorBlinking: false,
    cursorStyle: 1,
    dirtyRows: new Set(rows.map((_, index) => index)),
    rowData: rows.map((cells) => ({
      cells,
      text: cells.map((each) => each.text).join(""),
      isWrapContinuation: false,
      wrapsToNext: false,
    })),
  };
  renderGhosttySnapshot({
    context,
    snapshot,
    metrics: options.metrics ?? { width: 8, height: 26, baseline: 18 },
    fontSize: 13,
    fontFamily: "monospace",
    padding: 0,
    ...(options.originY !== undefined ? { originY: options.originY } : {}),
    forceFull: false,
    cursorOn: true,
  });
  return { fills, texts };
}

describe("renderGhosttySnapshot sprite glyphs", () => {
  it("draws box and block glyphs as sprites and keeps text runs around them", () => {
    const { fills, texts } = render([["a", "b", "─", "█", "c"].map((text) => cell(text))]);
    expect(texts).toEqual(["ab", "c"]);
    for (let x = 16; x < 24; x += 1) expect(paintAt(fills, x, 12)).toBe(WHITE);
    expect(paintAt(fills, 16, 0)).toBe(BLACK);
    for (let y = 0; y < 26; y += 1) expect(paintAt(fills, 24, y)).toBe(WHITE);
  });

  it("draws a sprite under a block cursor in the background colour", () => {
    const { fills, texts } = render([[cell("█")]], { cursorX: 0 });
    expect(texts).toEqual([]);
    expect(fills.slice(-2)).toEqual([
      { style: CURSOR, x: 0, y: 0, width: 8, height: 26 },
      { style: BLACK, x: 0, y: 0, width: 8, height: 26 },
    ]);
  });

  it("keeps every fill on whole device pixels at a fractional scale", () => {
    // Cell edges land between device pixels: 7.8 × 1.5 and (0.2 + 19) × 1.5.
    const row = () => [
      cell(" ", { background: { r: 0, g: 0, b: 255 } }),
      cell("│"),
      cell("x", { selected: true }),
    ];
    const { fills } = render([row(), row()], {
      cursorX: 2,
      scale: 1.5,
      metrics: { width: 7.8, height: 19, baseline: 14 },
      originY: 0.2,
    });
    for (const { x, y, width, height } of fills) {
      expect([x, y, width, height].every(Number.isInteger)).toBe(true);
    }
    // The second row's clear must not cut into the line drawn in the first.
    const line = fills.filter((fill) => fill.style === WHITE);
    const lineX = line[0]!.x;
    const top = Math.min(...line.map((fill) => fill.y));
    const bottom = Math.max(...line.map((fill) => fill.y + fill.height));
    expect(bottom - top).toBe(57);
    for (let y = top; y < bottom; y += 1) expect(paintAt(fills, lineX, y)).toBe(WHITE);
  });
});
