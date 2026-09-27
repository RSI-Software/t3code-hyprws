import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import spriteWasmDataUrl from "../vendor/ghostty-sprite.wasm?inline";
import pinnedVersion from "../../../../../../native/libghostty-vt/VERSION?raw";
import {
  drawGhosttySprite,
  fillGhosttyCellRect,
  ghosttySpriteCodepoint,
  loadGhosttySprites,
} from "./draw";
import { TestSpriteCanvas, TestSpritePath } from "./testCanvas";

vi.mock("../vendor/ghostty-sprite.wasm?url", async () => ({
  default: (await import("../vendor/ghostty-sprite.wasm?inline")).default,
}));

interface Blit {
  readonly image: TestSpriteCanvas;
  readonly x: number;
  readonly y: number;
}

/** One filled rect in device pixels, with the style and alpha it was filled in. */
interface Fill {
  readonly rect: readonly [number, number, number, number];
  readonly style: string;
  readonly alpha: number;
}

interface AxisTransform {
  readonly a: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** Records blits, path fills, and plain fills in device pixels under an axis-aligned transform. */
function recordingContext(scale = 1) {
  const blits: Blit[] = [];
  const fills: Fill[] = [];
  const rects: Array<readonly [number, number, number, number]> = [];
  let current: AxisTransform = { a: scale, d: scale, e: 0, f: 0 };
  let style = "";
  let alpha = 1;
  const stack: Array<[AxisTransform, string, number]> = [];
  const device = (x: number, y: number, width: number, height: number) =>
    [
      current.a * x + current.e,
      current.d * y + current.f,
      current.a * width,
      current.d * height,
    ] as const;
  const context = {
    getTransform: () => current,
    setTransform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => {
      current = { a, d, e, f };
    },
    save: () => stack.push([current, style, alpha]),
    restore: () => {
      [current, style, alpha] = stack.pop() ?? [current, style, alpha];
    },
    set fillStyle(value: string) {
      style = value;
    },
    set globalAlpha(value: number) {
      alpha = value;
    },
    drawImage: (image: TestSpriteCanvas, x: number, y: number) =>
      blits.push({ image, x: current.a * x + current.e, y: current.d * y + current.f }),
    fill: (path: TestSpritePath) => {
      for (const rect of path.rects) fills.push({ rect: device(...rect), style, alpha });
    },
    fillRect: (x: number, y: number, width: number, height: number) =>
      rects.push(device(x, y, width, height)),
  } as unknown as CanvasRenderingContext2D;
  return { context, blits, fills, rects };
}

const WHITE = { r: 255, g: 255, b: 255 };
const RED = { r: 255, g: 0, b: 0 };

beforeAll(async () => {
  vi.stubGlobal("OffscreenCanvas", TestSpriteCanvas);
  vi.stubGlobal("Path2D", TestSpritePath);
  await loadGhosttySprites();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("ghostty-sprite.wasm", () => {
  it("stays within its size budget", () => {
    const encoded = spriteWasmDataUrl.split(",", 2)[1] ?? "";
    expect(atob(encoded).length).toBeLessThan(250_000);
  });

  it("was built from the pinned Ghostty revision", async () => {
    const encoded = spriteWasmDataUrl.split(",", 2)[1] ?? "";
    const wasm = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const { instance } = await WebAssembly.instantiate(wasm);
    const memory = instance.exports.memory as WebAssembly.Memory;
    const pointer = (instance.exports.t3_sprite_revision as () => number)();
    const bytes = new Uint8Array(memory.buffer, pointer);
    const revision = new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
    expect(revision).toBe(pinnedVersion.trim());
  });
});

describe("ghosttySpriteCodepoint", () => {
  it("claims every family Ghostty draws as a sprite", () => {
    // Box, block, Braille, Powerline, branch, sextant, octant, geometric.
    for (const codepoint of [0x2500, 0x2588, 0x283f, 0xe0b0, 0xf5d0, 0x1fb00, 0x1cd00, 0x25e2]) {
      expect(ghosttySpriteCodepoint(String.fromCodePoint(codepoint))).toBe(codepoint);
    }
  });

  it("leaves text, clusters, and font glyphs to the font", () => {
    for (const text of ["", "a", "é", "你", "─́", ""]) {
      expect(ghosttySpriteCodepoint(text)).toBeNull();
    }
  });
});

describe("drawGhosttySprite", () => {
  it("fills a full block over a fractional cell on whole device pixels", () => {
    const { context, blits, fills } = recordingContext(1.5);
    drawGhosttySprite(context, 0x2588, 7.8, 0.2, 7.8, 19, RED, 13);
    // Edges 11.7 → 12 and 23.4 → 23 across, 0.3 → 0 and 28.8 → 29 down.
    expect(blits).toEqual([]);
    expect(fills).toEqual([{ rect: [12, 0, 11, 29], style: "rgb(255, 0, 0)", alpha: 1 }]);
  });

  it("centres a light horizontal line at the box thickness", () => {
    for (const [fontSize, thickness] of [
      [13, 1],
      [40, 2],
    ] as const) {
      const { context, fills } = recordingContext();
      drawGhosttySprite(context, 0x2500, 0, 0, 8, 26, WHITE, fontSize);
      expect(fills).toHaveLength(1);
      const [x, y, width, height] = fills[0]!.rect;
      expect([x, width, height]).toEqual([0, 8, thickness]);
      expect(Math.abs(y + height / 2 - 13)).toBeLessThanOrEqual(0.5);
    }
  });

  it("fills simple shapes in any colour without tinting an image", () => {
    const { context, blits, fills } = recordingContext();
    // A gradient Braille graph: every cell a new colour.
    for (let index = 0; index < 2048; index += 1) {
      const color = { r: index & 255, g: index >> 3, b: 90 };
      drawGhosttySprite(context, 0x2800 + (index & 255), 0, 0, 8, 26, color, 13);
    }
    expect(blits).toEqual([]);
    expect(fills.at(-1)!.style).toBe("rgb(255, 255, 90)");
  });

  it("tints an intricate shape once per colour and reuses it", () => {
    const { context, blits, fills } = recordingContext();
    drawGhosttySprite(context, 0xe0b0, 0, 0, 8, 26, WHITE, 13);
    drawGhosttySprite(context, 0xe0b0, 8, 0, 8, 26, WHITE, 13);
    drawGhosttySprite(context, 0xe0b0, 16, 0, 8, 26, RED, 13);
    expect(fills).toEqual([]);
    const [first, second, third] = blits as [Blit, Blit, Blit];
    expect([first.x, second.x, third.x]).toEqual([0, 8, 16]);
    expect(second.image).toBe(first.image);
    expect(third.image).not.toBe(first.image);
    expect(third.image.pixel(0, 13)).toEqual([255, 0, 0, first.image.pixel(0, 13)[3]]);
  });

  it("fills cell backgrounds on the grid a neighbouring sprite starts from", () => {
    const { context, fills, rects } = recordingContext(1.5);
    fillGhosttyCellRect(context, 0, 0, 7.8, 19);
    drawGhosttySprite(context, 0x2588, 7.8, 0, 7.8, 19, WHITE, 13);
    expect(rects[0]).toEqual([0, 0, 12, 29]);
    expect(fills[0]!.rect[0]).toBe(12);
  });

  // Runs last: it spends the module's tint budget.
  it("fills intricate shapes once the tint budget is spent", () => {
    const { context, blits, fills } = recordingContext();
    for (let index = 0; index < 1100; index += 1) {
      drawGhosttySprite(context, 0xe0b0, 0, 0, 8, 26, { r: index & 255, g: index >> 8, b: 0 }, 13);
    }
    expect(blits.length).toBeLessThan(1100);
    expect(fills.length).toBeGreaterThan(0);
    const alphas = new Set(fills.map((fill) => fill.alpha));
    expect(alphas.has(1)).toBe(true);
    expect(alphas.size).toBeGreaterThan(1);
  });
});
