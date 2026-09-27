import { describe, expect, it } from "vite-plus/test";

import { drawGhosttySprite, fillGhosttyCellRect, ghosttySpriteCodepoint } from "./draw";

interface Recorded {
  readonly rects: Array<readonly [number, number, number, number]>;
  readonly points: Array<readonly [number, number]>;
}

interface AxisTransform {
  readonly a: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** Records fills and path points in device pixels under an axis-aligned transform. */
function recordingContext(scale = 1): { context: CanvasRenderingContext2D; recorded: Recorded } {
  const recorded: Recorded = { rects: [], points: [] };
  let current: AxisTransform = { a: scale, d: scale, e: 0, f: 0 };
  const stack: AxisTransform[] = [];
  const device = (x: number, y: number): readonly [number, number] => [
    current.a * x + current.e,
    current.d * y + current.f,
  ];
  const point = (x: number, y: number) => recorded.points.push(device(x, y));
  const context = {
    getTransform: () => current,
    setTransform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => {
      current = { a, d, e, f };
    },
    transform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => {
      current = {
        a: current.a * a,
        d: current.d * d,
        e: current.a * e + current.e,
        f: current.d * f + current.f,
      };
    },
    save: () => stack.push(current),
    restore: () => {
      current = stack.pop() ?? current;
    },
    fillRect: (x: number, y: number, width: number, height: number) => {
      const [x0, y0] = device(x, y);
      const [x1, y1] = device(x + width, y + height);
      recorded.rects.push([
        Math.min(x0, x1),
        Math.min(y0, y1),
        Math.abs(x1 - x0),
        Math.abs(y1 - y0),
      ]);
    },
    moveTo: point,
    lineTo: point,
    bezierCurveTo: (_1: number, _2: number, _3: number, _4: number, x: number, y: number) =>
      point(x, y),
    beginPath: () => {},
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    fill: () => {},
    stroke: () => {},
    globalAlpha: 1,
    lineCap: "butt",
    lineWidth: 1,
    fillStyle: "",
    strokeStyle: "",
  } as unknown as CanvasRenderingContext2D;
  return { context, recorded };
}

const char = String.fromCodePoint;

function covers(rects: Recorded["rects"], x: number, y: number): boolean {
  return rects.some(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h);
}

function draw(
  text: string,
  cell: { left: number; top: number; width: number; height: number },
  scale = 1,
): Recorded {
  const { context, recorded } = recordingContext(scale);
  const codepoint = ghosttySpriteCodepoint(text);
  if (codepoint === null) throw new Error(`${text} is not a sprite`);
  drawGhosttySprite(context, codepoint, cell.left, cell.top, cell.width, cell.height, "#fff", 13);
  return recorded;
}

describe("ghosttySpriteCodepoint", () => {
  it("claims single sprite codepoints, including astral mosaics", () => {
    const codepoints = [0x2500, 0x256d, 0x2588, 0x259a, 0x28ff, 0xe0b0, 0xe0b4, 0x25e2];
    for (const codepoint of [...codepoints, 0x1fb00, 0x1cd00]) {
      expect(ghosttySpriteCodepoint(char(codepoint))).toBe(codepoint);
    }
  });

  it("leaves text, clusters, and unported glyphs to the font", () => {
    for (const text of ["", "a", "─́", "──", "", "🬼", "😀"]) {
      expect(ghosttySpriteCodepoint(text)).toBeNull();
    }
  });
});

describe("drawGhosttySprite", () => {
  it("draws vertical box lines through the whole row at any line height", () => {
    const { rects } = draw("│", { left: 0, top: 0, width: 8, height: 26 });
    for (let y = 0; y < 26; y += 1) expect(covers(rects, 3, y)).toBe(true);
    expect(rects.every(([x, , w]) => x === 3 && w === 1)).toBe(true);
  });

  it("joins a light cross at the centre without gaps", () => {
    const { rects } = draw("┼", { left: 0, top: 0, width: 9, height: 21 });
    for (let x = 0; x < 9; x += 1) expect(covers(rects, x, 10)).toBe(true);
    for (let y = 0; y < 21; y += 1) expect(covers(rects, 4, y)).toBe(true);
  });

  it("snaps fractional cells to device pixels that neighbouring cells share", () => {
    const first = draw("█", { left: 4, top: 10, width: 7.8, height: 20 }, 2);
    const second = draw("█", { left: 11.8, top: 10, width: 7.8, height: 20 }, 2);
    const [[x0, y0, w0, h0]] = first.rects as [[number, number, number, number]];
    const [[x1]] = second.rects as [[number, number, number, number]];
    expect([x0, y0, h0]).toEqual([8, 20, 40]);
    expect(x0 + w0).toBe(x1);
  });

  it("fills cell backgrounds on the grid a neighbouring sprite starts from", () => {
    const { context, recorded } = recordingContext(2);
    fillGhosttyCellRect(context, 4, 10, 7.8, 20);
    const sprite = draw("█", { left: 11.8, top: 10, width: 7.8, height: 20 }, 2);
    const [[x0, y0, w0, h0]] = recorded.rects as [[number, number, number, number]];
    const [[x1]] = sprite.rects as [[number, number, number, number]];
    expect([x0, y0, h0]).toEqual([8, 20, 40]);
    expect(x0 + w0).toBe(x1);
  });

  it("draws Powerline triangles across the full cell height", () => {
    const { points } = draw(char(0xe0b0), { left: 0, top: 0, width: 8, height: 26 });
    expect(points).toEqual([
      [0, 0],
      [8, 13],
      [0, 26],
    ]);
  });

  it("points left-facing Powerline caps the other way", () => {
    const { points } = draw(char(0xe0b2), { left: 0, top: 0, width: 8, height: 26 });
    expect(points).toEqual([
      [8, 0],
      [0, 13],
      [8, 26],
    ]);
  });

  it("splits half blocks symmetrically on odd cells", () => {
    const upper = draw("▘", { left: 0, top: 0, width: 9, height: 21 }).rects;
    const lower = draw("▖", { left: 0, top: 0, width: 9, height: 21 }).rects;
    expect(upper).toEqual([[0, 0, 5, 11]]);
    expect(lower).toEqual([[0, 10, 5, 11]]);
  });

  it("maps sextants past the codepoints taken by half blocks", () => {
    // U+1FB14 follows the skipped left-half pattern, so it is tr + ml + bl.
    const rects = draw(char(0x1fb14), { left: 0, top: 0, width: 8, height: 24 }).rects;
    expect(rects).toEqual([
      [4, 0, 4, 8],
      [0, 8, 4, 8],
      [0, 16, 4, 8],
    ]);
  });

  it("reads every octant in the table", () => {
    const last = draw(char(0x1cde5), { left: 0, top: 0, width: 8, height: 24 }).rects;
    expect(last).toHaveLength(7);
    const first = draw(char(0x1cd00), { left: 0, top: 0, width: 8, height: 24 }).rects;
    expect(first).toEqual([[0, 6, 4, 6]]);
  });

  it("places all eight Braille dots inside the cell", () => {
    const { rects } = draw("⣿", { left: 0, top: 0, width: 8, height: 26 });
    expect(rects).toHaveLength(8);
    for (const [x, y, w, h] of rects) {
      expect(x >= 0 && y >= 0 && x + w <= 8 && y + h <= 26 && w > 0 && h > 0).toBe(true);
    }
  });
});
