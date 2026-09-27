// Box Drawing, U+2500..U+257F, ported from Ghostty `draw/box.zig` (MIT).

import {
  centered,
  hlineMiddle,
  type SpriteCanvas,
  type SpriteMetrics,
  thicknessPx,
  vlineMiddle,
} from "./canvas";

const NONE = 0;
const LIGHT = 1;
const HEAVY = 2;
const DOUBLE = 3;

type LineStyle = typeof NONE | typeof LIGHT | typeof HEAVY | typeof DOUBLE;

interface Lines {
  readonly up: LineStyle;
  readonly right: LineStyle;
  readonly down: LineStyle;
  readonly left: LineStyle;
}

// One entry per codepoint from U+2500: the up, right, down, and left arm as
// 0 none, 1 light, 2 heavy, 3 double. `....` marks a dash, arc, or diagonal.
const LINES: ReadonlyArray<Lines | null> = (
  "0101 0202 1010 2020 .... .... .... .... .... .... .... .... 0110 0210 0120 0220 " +
  "0011 0012 0021 0022 1100 1200 2100 2200 1001 1002 2001 2002 1110 1210 2110 1120 " +
  "2120 2210 1220 2220 1011 1012 2011 1021 2021 2012 1022 2022 0111 0112 0211 0212 " +
  "0121 0122 0221 0222 1101 1102 1201 1202 2101 2102 2201 2202 1111 1112 1211 1212 " +
  "2111 1121 2121 2112 2211 1122 1221 2212 1222 2122 2221 2222 .... .... .... .... " +
  "0303 3030 0310 0130 0330 0013 0031 0033 1300 3100 3300 1003 3001 3003 1310 3130 " +
  "3330 1013 3031 3033 0313 0131 0333 1303 3101 3303 1313 3131 3333 .... .... .... " +
  ".... .... .... .... 0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010"
)
  .split(" ")
  .map((entry) => {
    if (entry === "....") return null;
    const [up, right, down, left] = Array.from(entry, (digit) => Number(digit) as LineStyle);
    return { up: up!, right: right!, down: down!, left: left! };
  });

export function drawBox(codepoint: number, canvas: SpriteCanvas, metrics: SpriteMetrics): void {
  const lines = LINES[codepoint - 0x2500];
  if (lines) {
    linesChar(metrics, canvas, lines);
    return;
  }
  const light = thicknessPx("light", metrics.boxThickness);
  const heavy = thicknessPx("heavy", metrics.boxThickness);
  const dashGap = Math.max(4, light);
  switch (codepoint) {
    case 0x2504:
      return dashHorizontal(metrics, canvas, 3, light, dashGap);
    case 0x2505:
      return dashHorizontal(metrics, canvas, 3, heavy, dashGap);
    case 0x2506:
      return dashVertical(metrics, canvas, 3, light, dashGap);
    case 0x2507:
      return dashVertical(metrics, canvas, 3, heavy, dashGap);
    case 0x2508:
      return dashHorizontal(metrics, canvas, 4, light, dashGap);
    case 0x2509:
      return dashHorizontal(metrics, canvas, 4, heavy, dashGap);
    case 0x250a:
      return dashVertical(metrics, canvas, 4, light, dashGap);
    case 0x250b:
      return dashVertical(metrics, canvas, 4, heavy, dashGap);
    case 0x254c:
      return dashHorizontal(metrics, canvas, 2, light, light);
    case 0x254d:
      return dashHorizontal(metrics, canvas, 2, heavy, heavy);
    case 0x254e:
      return dashVertical(metrics, canvas, 2, light, heavy);
    case 0x254f:
      return dashVertical(metrics, canvas, 2, heavy, heavy);
    case 0x256d:
      return arc(metrics, canvas, "br");
    case 0x256e:
      return arc(metrics, canvas, "bl");
    case 0x256f:
      return arc(metrics, canvas, "tl");
    case 0x2570:
      return arc(metrics, canvas, "tr");
    case 0x2571:
      return lightDiagonalUpperRightToLowerLeft(metrics, canvas);
    case 0x2572:
      return lightDiagonalUpperLeftToLowerRight(metrics, canvas);
    case 0x2573:
      lightDiagonalUpperRightToLowerLeft(metrics, canvas);
      lightDiagonalUpperLeftToLowerRight(metrics, canvas);
      return;
  }
}

function linesChar(metrics: SpriteMetrics, canvas: SpriteCanvas, lines: Lines): void {
  const { cellWidth: width, cellHeight: height } = metrics;
  const lightPx = thicknessPx("light", metrics.boxThickness);
  const heavyPx = thicknessPx("heavy", metrics.boxThickness);

  const hLightTop = centered(height, lightPx);
  const hLightBottom = hLightTop + lightPx;
  const hHeavyTop = centered(height, heavyPx);
  const hHeavyBottom = hHeavyTop + heavyPx;
  const hDoubleTop = Math.max(0, hLightTop - lightPx);
  const hDoubleBottom = hLightBottom + lightPx;

  const vLightLeft = centered(width, lightPx);
  const vLightRight = vLightLeft + lightPx;
  const vHeavyLeft = centered(width, heavyPx);
  const vHeavyRight = vHeavyLeft + heavyPx;
  const vDoubleLeft = Math.max(0, vLightLeft - lightPx);
  const vDoubleRight = vLightRight + lightPx;

  const { up, right, down, left } = lines;

  // Where each arm stops so crossing strokes join without notches or overshoot.
  const upBottom =
    left === HEAVY || right === HEAVY
      ? hHeavyBottom
      : left !== right || down === up
        ? left === DOUBLE || right === DOUBLE
          ? hDoubleBottom
          : hLightBottom
        : left === NONE && right === NONE
          ? hLightBottom
          : hLightTop;
  const downTop =
    left === HEAVY || right === HEAVY
      ? hHeavyTop
      : left !== right || up === down
        ? left === DOUBLE || right === DOUBLE
          ? hDoubleTop
          : hLightTop
        : left === NONE && right === NONE
          ? hLightTop
          : hLightBottom;
  const leftRight =
    up === HEAVY || down === HEAVY
      ? vHeavyRight
      : up !== down || left === right
        ? up === DOUBLE || down === DOUBLE
          ? vDoubleRight
          : vLightRight
        : up === NONE && down === NONE
          ? vLightRight
          : vLightLeft;
  const rightLeft =
    up === HEAVY || down === HEAVY
      ? vHeavyLeft
      : up !== down || right === left
        ? up === DOUBLE || down === DOUBLE
          ? vDoubleLeft
          : vLightLeft
        : up === NONE && down === NONE
          ? vLightLeft
          : vLightRight;

  if (up === LIGHT) canvas.box(vLightLeft, 0, vLightRight, upBottom);
  else if (up === HEAVY) canvas.box(vHeavyLeft, 0, vHeavyRight, upBottom);
  else if (up === DOUBLE) {
    canvas.box(vDoubleLeft, 0, vLightLeft, left === DOUBLE ? hLightTop : upBottom);
    canvas.box(vLightRight, 0, vDoubleRight, right === DOUBLE ? hLightTop : upBottom);
  }

  if (right === LIGHT) canvas.box(rightLeft, hLightTop, width, hLightBottom);
  else if (right === HEAVY) canvas.box(rightLeft, hHeavyTop, width, hHeavyBottom);
  else if (right === DOUBLE) {
    canvas.box(up === DOUBLE ? vLightRight : rightLeft, hDoubleTop, width, hLightTop);
    canvas.box(down === DOUBLE ? vLightRight : rightLeft, hLightBottom, width, hDoubleBottom);
  }

  if (down === LIGHT) canvas.box(vLightLeft, downTop, vLightRight, height);
  else if (down === HEAVY) canvas.box(vHeavyLeft, downTop, vHeavyRight, height);
  else if (down === DOUBLE) {
    canvas.box(vDoubleLeft, left === DOUBLE ? hLightBottom : downTop, vLightLeft, height);
    canvas.box(vLightRight, right === DOUBLE ? hLightBottom : downTop, vDoubleRight, height);
  }

  if (left === LIGHT) canvas.box(0, hLightTop, leftRight, hLightBottom);
  else if (left === HEAVY) canvas.box(0, hHeavyTop, leftRight, hHeavyBottom);
  else if (left === DOUBLE) {
    canvas.box(0, hDoubleTop, up === DOUBLE ? vLightLeft : leftRight, hLightTop);
    canvas.box(0, hLightBottom, down === DOUBLE ? vLightLeft : leftRight, hDoubleBottom);
  }
}

// The diagonals overshoot the corners slightly, keeping the true slope, so
// they meet the neighbouring cell's diagonal without a gap.
function diagonalOvershoot(metrics: SpriteMetrics): { x: number; y: number } {
  const { cellWidth: width, cellHeight: height } = metrics;
  return { x: 0.5 * Math.min(1, width / height), y: 0.5 * Math.min(1, height / width) };
}

export function lightDiagonalUpperRightToLowerLeft(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
): void {
  const over = diagonalOvershoot(metrics);
  canvas.line(
    metrics.cellWidth + over.x,
    -over.y,
    -over.x,
    metrics.cellHeight + over.y,
    thicknessPx("light", metrics.boxThickness),
  );
}

export function lightDiagonalUpperLeftToLowerRight(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
): void {
  const over = diagonalOvershoot(metrics);
  canvas.line(
    -over.x,
    -over.y,
    metrics.cellWidth + over.x,
    metrics.cellHeight + over.y,
    thicknessPx("light", metrics.boxThickness),
  );
}

/** Rounded corner; `corner` names the quadrant the arc bends toward. */
function arc(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
  corner: "tl" | "tr" | "bl" | "br",
): void {
  const { cellWidth: width, cellHeight: height } = metrics;
  const thick = thicknessPx("light", metrics.boxThickness);
  const cx = centered(width, thick) + thick / 2;
  const cy = centered(height, thick) + thick / 2;
  const r = Math.min(width, height) / 2;
  // Fraction of the radius from the centre for the middle control points.
  const s = 0.25;
  const vertical = corner[0] === "t" ? -1 : 1;
  const horizontal = corner[1] === "l" ? -1 : 1;
  canvas.strokePath((path) => {
    path.moveTo(cx, vertical < 0 ? 0 : height);
    path.lineTo(cx, cy + vertical * r);
    path.bezierCurveTo(
      cx,
      cy + vertical * s * r,
      cx + horizontal * s * r,
      cy,
      cx + horizontal * r,
      cy,
    );
    path.lineTo(horizontal < 0 ? 0 : width, cy);
  }, thick);
}

// Dashes tile seamlessly: half gaps on both sides horizontally, one full gap
// at the bottom vertically, and spare pixels widen the first dashes.
function dashHorizontal(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
  count: number,
  thick: number,
  desiredGap: number,
): void {
  const width = metrics.cellWidth;
  if (width < count * 2) {
    hlineMiddle(metrics, canvas, "light");
    return;
  }
  const gap = Math.min(desiredGap, Math.floor(width / (2 * count)));
  const totalDash = width - count * gap;
  const dash = Math.floor(totalDash / count);
  let extra = totalDash % count;
  const y = centered(metrics.cellHeight, thick);
  let x = Math.floor(gap / 2);
  for (let index = 0; index < count; index += 1) {
    let x1 = x + dash;
    if (extra > 0) {
      extra -= 1;
      x1 += 1;
    }
    canvas.box(x, y, x1, y + thick);
    x = x1 + gap;
  }
}

function dashVertical(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
  count: number,
  thick: number,
  desiredGap: number,
): void {
  const height = metrics.cellHeight;
  if (height < count * 2) {
    vlineMiddle(metrics, canvas, "light");
    return;
  }
  const gap = Math.min(desiredGap, Math.floor(height / (2 * count)));
  const totalDash = height - count * gap;
  const dash = Math.floor(totalDash / count);
  let extra = totalDash % count;
  const x = centered(metrics.cellWidth, thick);
  let y = 0;
  for (let index = 0; index < count; index += 1) {
    let y1 = y + dash;
    if (extra > 0) {
      extra -= 1;
      y1 += 1;
    }
    canvas.box(x, y, x + thick, y1);
    y = y1 + gap;
  }
}
