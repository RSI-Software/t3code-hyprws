// Drawing primitives for the terminal sprite glyphs, ported from Ghostty's
// sprite font (ghostty-org/ghostty `src/font/sprite`, MIT). Coordinates are
// whole device pixels relative to the cell's top-left corner, exactly like
// Ghostty's sprite canvas, so neighbouring cells meet without seams.

export interface SpriteMetrics {
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Base stroke width in device pixels; Ghostty derives it from the face's underline. */
  readonly boxThickness: number;
}

type Thickness = "light" | "heavy";

export function thicknessPx(thickness: Thickness, base: number): number {
  return thickness === "heavy" ? base * 2 : base;
}

/** Ghostty's shade levels as alpha fractions. */
export const SHADE = {
  light: 0x40 / 0xff,
  medium: 0x80 / 0xff,
  dark: 0xc0 / 0xff,
  on: 1,
} as const;

/** Saturating subtract then halve, Ghostty's `(a -| b) / 2` on unsigned pixels. */
export function centered(size: number, thickness: number): number {
  return Math.floor(Math.max(0, size - thickness) / 2);
}

/**
 * Pixel edges for a cell fraction. A min edge rounds from the far side so a
 * `0 → ½` block and a `½ → 1` block come out the same size on an odd cell,
 * sharing the middle pixel.
 */
function fractionMin(fraction: number, size: number): number {
  return size - Math.round((1 - fraction) * size);
}

function fractionMax(fraction: number, size: number): number {
  return Math.round(fraction * size);
}

export type SpritePath = Pick<
  CanvasRenderingContext2D,
  "moveTo" | "lineTo" | "bezierCurveTo" | "closePath"
>;

export type SpriteContext = SpritePath &
  Pick<
    CanvasRenderingContext2D,
    | "beginPath"
    | "clip"
    | "fill"
    | "fillRect"
    | "globalAlpha"
    | "lineCap"
    | "lineWidth"
    | "restore"
    | "save"
    | "stroke"
    | "transform"
  >;

export class SpriteCanvas {
  constructor(
    readonly context: SpriteContext,
    readonly width: number,
    readonly height: number,
  ) {}

  /** Fill the pixels between two corners, in either order. */
  box(x0: number, y0: number, x1: number, y1: number, shade: number = SHADE.on): void {
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    if (width <= 0 || height <= 0) return;
    this.withShade(shade, () => this.context.fillRect(left, top, width, height));
  }

  rect(x: number, y: number, width: number, height: number, shade: number = SHADE.on): void {
    this.box(x, y, x + width, y + height, shade);
  }

  fillPath(build: (path: SpritePath) => void, shade: number = SHADE.on): void {
    this.withShade(shade, () => {
      this.context.beginPath();
      build(this.context);
      this.context.fill();
    });
  }

  triangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
    this.fillPath((path) => {
      path.moveTo(x0, y0);
      path.lineTo(x1, y1);
      path.lineTo(x2, y2);
      path.closePath();
    });
  }

  strokePath(build: (path: SpritePath) => void, lineWidth: number): void {
    const { context } = this;
    context.save();
    context.lineCap = "butt";
    context.lineWidth = lineWidth;
    context.beginPath();
    build(context);
    context.stroke();
    context.restore();
  }

  /** Stroke that stays inside the closed shape, like Ghostty's `innerStrokePath`. */
  innerStrokePath(build: (path: SpritePath) => void, lineWidth: number): void {
    const { context } = this;
    context.save();
    context.beginPath();
    build(context);
    context.closePath();
    context.clip();
    context.lineCap = "butt";
    context.lineWidth = lineWidth * 2;
    context.beginPath();
    build(context);
    context.stroke();
    context.restore();
  }

  line(x0: number, y0: number, x1: number, y1: number, lineWidth: number): void {
    this.strokePath((path) => {
      path.moveTo(x0, y0);
      path.lineTo(x1, y1);
    }, lineWidth);
  }

  /** Draw mirrored across the cell's vertical centre line. */
  flippedHorizontally(draw: () => void): void {
    this.context.save();
    this.context.transform(-1, 0, 0, 1, this.width, 0);
    draw();
    this.context.restore();
  }

  private withShade(shade: number, draw: () => void): void {
    if (shade === SHADE.on) {
      draw();
      return;
    }
    const previous = this.context.globalAlpha;
    this.context.globalAlpha = previous * shade;
    draw();
    this.context.globalAlpha = previous;
  }
}

/** Fill the region between two horizontal and two vertical cell fractions. */
export function fill(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  canvas.box(
    fractionMin(x0, metrics.cellWidth),
    fractionMin(y0, metrics.cellHeight),
    fractionMax(x1, metrics.cellWidth),
    fractionMax(y1, metrics.cellHeight),
  );
}

export function hlineMiddle(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
  thickness: Thickness,
): void {
  const px = thicknessPx(thickness, metrics.boxThickness);
  const y = centered(metrics.cellHeight, px);
  canvas.box(0, y, metrics.cellWidth, y + px);
}

export function vlineMiddle(
  metrics: SpriteMetrics,
  canvas: SpriteCanvas,
  thickness: Thickness,
): void {
  const px = thicknessPx(thickness, metrics.boxThickness);
  const x = centered(metrics.cellWidth, px);
  canvas.box(x, 0, x + px, metrics.cellHeight);
}
