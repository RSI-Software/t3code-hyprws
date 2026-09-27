// OffscreenCanvas and Path2D stand-ins for tests. Sprite tinting only creates
// and puts one ImageData per canvas, and sprite paths only add rects.
export class TestSpriteCanvas {
  pixels: Uint8ClampedArray = new Uint8ClampedArray(0);

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext() {
    return {
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: (image: { readonly data: Uint8ClampedArray }) => {
        this.pixels = image.data;
      },
    };
  }

  /** RGBA at (x, y). */
  pixel(x: number, y: number): readonly number[] {
    const offset = (y * this.width + x) * 4;
    return [...this.pixels.subarray(offset, offset + 4)];
  }
}

export class TestSpritePath {
  readonly rects: Array<readonly [number, number, number, number]> = [];

  rect(x: number, y: number, width: number, height: number) {
    this.rects.push([x, y, width, height]);
  }
}
