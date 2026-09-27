import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { GhosttyCell, GhosttySnapshot } from "./core";
import { type GhosttyCellMetrics, renderGhosttySnapshot } from "./renderer";
import { loadGhosttySprites } from "./sprite/draw";
import { TestSpriteCanvas, TestSpritePath } from "./sprite/testCanvas";

vi.mock("./vendor/ghostty-sprite.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-sprite.wasm?inline")).default,
}));

beforeAll(async () => {
  vi.stubGlobal("OffscreenCanvas", TestSpriteCanvas);
  vi.stubGlobal("Path2D", TestSpritePath);
  await loadGhosttySprites();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

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

/** Renders one frame and records every rect fill and sprite path fill in device pixels. */
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
  const sprites: Fill[] = [];
  const texts: string[] = [];
  let fillStyle = "";
  let current: AxisTransform = { a: scale, d: scale, e: 0, f: 0 };
  const stack: Array<[AxisTransform, string]> = [];
  const device = (x: number, y: number, width: number, height: number): Fill => ({
    style: fillStyle,
    x: current.a * x + current.e,
    y: current.d * y + current.f,
    width: current.a * width,
    height: current.d * height,
  });
  const context = {
    canvas: { width: 400, height: 200 },
    getTransform: () => current,
    setTransform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => {
      current = { a, d, e, f };
    },
    save: () => stack.push([current, fillStyle]),
    restore: () => {
      [current, fillStyle] = stack.pop() ?? [current, fillStyle];
    },
    fillRect: (x: number, y: number, width: number, height: number) =>
      fills.push(device(x, y, width, height)),
    fill: (path: TestSpritePath) => {
      for (const rect of path.rects) sprites.push(device(...rect));
    },
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
    set globalAlpha(_value: number) {},
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
  return { fills, sprites, texts };
}

describe("renderGhosttySnapshot sprite glyphs", () => {
  it("draws box and block glyphs as sprites and keeps text runs around them", () => {
    const { sprites, texts } = render([["a", "b", "─", "█", "c"].map((text) => cell(text))]);
    expect(texts).toEqual(["ab", "c"]);
    const [line, block] = sprites as [Fill, Fill];
    expect([line.x, line.width]).toEqual([16, 8]);
    expect(block).toEqual({ style: "rgb(255, 255, 255)", x: 24, y: 0, width: 8, height: 26 });
  });

  it("draws a sprite under a block cursor in the background colour", () => {
    const { fills, sprites, texts } = render([[cell("█")]], { cursorX: 0 });
    expect(texts).toEqual([]);
    expect(fills.at(-1)).toEqual({ style: CURSOR, x: 0, y: 0, width: 8, height: 26 });
    expect(sprites.at(-1)).toEqual({ style: "rgb(0, 0, 0)", x: 0, y: 0, width: 8, height: 26 });
  });

  it("keeps every fill and sprite on whole device pixels at a fractional scale", () => {
    // Cell edges land between device pixels: 7.8 × 1.5 and (0.2 + 19) × 1.5.
    const row = () => [
      cell(" ", { background: { r: 0, g: 0, b: 255 } }),
      cell("│"),
      cell("x", { selected: true }),
    ];
    const { fills, sprites } = render([row(), row()], {
      cursorX: 2,
      scale: 1.5,
      metrics: { width: 7.8, height: 19, baseline: 14 },
      originY: 0.2,
    });
    for (const { x, y, width, height } of [...fills, ...sprites]) {
      expect([x, y, width, height].every(Number.isInteger)).toBe(true);
    }
    // The two rows' line segments meet with no gap or overlap.
    const [upper, lower] = sprites as [Fill, Fill];
    expect(lower.x).toBe(upper.x);
    expect([upper.y, lower.y, lower.y + lower.height]).toEqual([0, 29, 57]);
  });
});
