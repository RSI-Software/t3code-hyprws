// Powerline and Powerline Extra geometric symbols U+E0B0..U+E0BF, U+E0D2,
// U+E0D4, ported from Ghostty `draw/powerline.zig` (MIT). The stylized
// Powerline Extra glyphs stay with the font, as in Ghostty.

import { lightDiagonalUpperLeftToLowerRight, lightDiagonalUpperRightToLowerLeft } from "./box";
import { type SpriteCanvas, type SpriteMetrics, type SpritePath, thicknessPx } from "./canvas";

// Control-point factor for a quarter circle drawn as one cubic Bézier.
const CIRCLE_CONTROL = ((Math.SQRT2 - 1) * 4) / 3;

function halfCircle(path: SpritePath, width: number, height: number): void {
  const radius = Math.min(width, height / 2);
  const control = radius * CIRCLE_CONTROL;
  path.moveTo(0, 0);
  path.bezierCurveTo(control, 0, radius, radius - control, radius, radius);
  path.lineTo(radius, height - radius);
  path.bezierCurveTo(radius, height - radius + control, control, height, 0, height);
}

function drawRightFacing(codepoint: number, canvas: SpriteCanvas, metrics: SpriteMetrics): void {
  const { cellWidth: width, cellHeight: height } = metrics;
  switch (codepoint) {
    case 0xe0b0:
      return canvas.triangle(0, 0, width, height / 2, 0, height);
    case 0xe0b1:
      return canvas.strokePath(
        (path) => {
          path.moveTo(0, 0);
          path.lineTo(width, height / 2);
          path.lineTo(0, height);
        },
        thicknessPx("light", metrics.boxThickness),
      );
    case 0xe0b4:
      return canvas.fillPath((path) => {
        halfCircle(path, width, height);
        path.closePath();
      });
    case 0xe0b5:
      return canvas.innerStrokePath(
        (path) => halfCircle(path, width, height),
        metrics.boxThickness,
      );
    case 0xe0d2: {
      const half = metrics.boxThickness / 2;
      canvas.fillPath((path) => {
        path.moveTo(0, 0);
        path.lineTo(width, 0);
        path.lineTo(width / 2, height / 2 - half);
        path.lineTo(0, height / 2 - half);
        path.closePath();
      });
      canvas.fillPath((path) => {
        path.moveTo(0, height);
        path.lineTo(width, height);
        path.lineTo(width / 2, height / 2 + half);
        path.lineTo(0, height / 2 + half);
        path.closePath();
      });
      return;
    }
  }
}

// Each left-facing glyph is its right-facing partner mirrored.
const MIRRORED: Record<number, number> = {
  0xe0b2: 0xe0b0,
  0xe0b3: 0xe0b1,
  0xe0b6: 0xe0b4,
  0xe0b7: 0xe0b5,
  0xe0d4: 0xe0d2,
};

export function drawPowerline(
  codepoint: number,
  canvas: SpriteCanvas,
  metrics: SpriteMetrics,
): void {
  const { cellWidth: width, cellHeight: height } = metrics;
  switch (codepoint) {
    case 0xe0b8:
      return canvas.triangle(0, 0, width, height, 0, height);
    case 0xe0ba:
      return canvas.triangle(width, 0, width, height, 0, height);
    case 0xe0bc:
      return canvas.triangle(0, 0, width, 0, 0, height);
    case 0xe0be:
      return canvas.triangle(0, 0, width, 0, width, height);
    case 0xe0b9:
    case 0xe0bf:
      return lightDiagonalUpperLeftToLowerRight(metrics, canvas);
    case 0xe0bb:
    case 0xe0bd:
      return lightDiagonalUpperRightToLowerLeft(metrics, canvas);
  }
  const mirrored = MIRRORED[codepoint];
  if (mirrored === undefined) {
    drawRightFacing(codepoint, canvas, metrics);
    return;
  }
  canvas.flippedHorizontally(() => drawRightFacing(mirrored, canvas, metrics));
}
