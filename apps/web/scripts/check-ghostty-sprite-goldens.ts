// @effect-diagnostics nodeBuiltinImport:off - build-time check run by build-libghostty-wasm.sh.
/**
 * Diffs ghostty-sprite.wasm against Ghostty's own sprite golden images
 * (src/font/sprite/testdata at the pinned revision). Each PNG is a 16x16 grid
 * of padded cells for one 256-codepoint page at one metric set; the wasm must
 * reproduce every page pixel for pixel.
 *
 * Usage: node check-ghostty-sprite-goldens.ts <ghostty-sprite.wasm> <testdata-dir>
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

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

// Metric sets from Ghostty's "sprite face render all sprites" test, keyed by
// the golden file suffix: cell width, ascent, descent, box thickness.
const METRIC_SETS: Record<string, readonly [number, number, number, number]> = {
  "18x36+4": [18, 30, 6, 4],
  "12x24+3": [12, 20, 4, 3],
  "11x21+2": [11, 19, 2, 2],
  "9x17+1": [9, 15, 2, 1],
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Decodes the only PNG shape z2d writes for alpha8 surfaces: 8-bit grayscale,
// non-interlaced.
function decodeGrayPng(buffer: Buffer): { width: number; height: number; pixels: Uint8Array } {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (buffer[24] !== 8 || buffer[25] !== 0 || buffer[28] !== 0) {
    throw new Error("expected an 8-bit grayscale, non-interlaced PNG");
  }
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = NodeZlib.inflateSync(Buffer.concat(chunks));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (width + 1)];
    for (let x = 0; x < width; x += 1) {
      const a = x > 0 ? pixels[y * width + x - 1]! : 0;
      const b = y > 0 ? pixels[(y - 1) * width + x]! : 0;
      const c = x > 0 && y > 0 ? pixels[(y - 1) * width + x - 1]! : 0;
      const predictor =
        filter === 1
          ? a
          : filter === 2
            ? b
            : filter === 3
              ? (a + b) >> 1
              : filter === 4
                ? paeth(a, b, c)
                : 0;
      pixels[y * width + x] = (raw[y * (width + 1) + 1 + x]! + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

const [wasmPath, testdataDir] = process.argv.slice(2);
if (!wasmPath || !testdataDir) {
  console.error("usage: node check-ghostty-sprite-goldens.ts <ghostty-sprite.wasm> <testdata-dir>");
  process.exit(2);
}

const { instance } = await WebAssembly.instantiate(NodeFS.readFileSync(wasmPath));
const sprite = instance.exports as unknown as SpriteExports;

let failedPages = 0;
let renderedGlyphs = 0;
const pages = NodeFS.readdirSync(testdataDir)
  .filter((file) => file.endsWith(".png"))
  .toSorted();
for (const file of pages) {
  const match = /^U\+([0-9A-F]+)\.\.\.U\+[0-9A-F]+-(\d+x\d+\+\d+)\.png$/.exec(file);
  const metrics = match ? METRIC_SETS[match[2]!] : undefined;
  if (!match || !metrics) throw new Error(`unrecognized golden file: ${file}`);
  const [cellWidth, ascent, descent, thickness] = metrics;
  const cellHeight = ascent + descent;
  const golden = decodeGrayPng(NodeFS.readFileSync(NodePath.join(testdataDir, file)));
  const paddedWidth = cellWidth + 2 * Math.floor(cellWidth / 4);
  const paddedHeight = cellHeight + 2 * Math.floor(cellHeight / 4);
  const actual = new Uint8Array(golden.width * golden.height);
  const failedGlyphs: string[] = [];
  for (let index = 0; index < 256; index += 1) {
    const codepoint = Number.parseInt(match[1]!, 16) + index;
    if (!sprite.t3_sprite_has(codepoint)) continue;
    const pointer = sprite.t3_sprite_render(codepoint, cellWidth, cellHeight, thickness, 1);
    if (pointer === 0) {
      failedGlyphs.push(`${codepoint.toString(16)}(render failed)`);
      continue;
    }
    renderedGlyphs += 1;
    const cell = new Uint8Array(sprite.memory.buffer, pointer, paddedWidth * paddedHeight);
    const originX = (index % 16) * paddedWidth;
    const originY = Math.floor(index / 16) * paddedHeight;
    for (let y = 0; y < paddedHeight; y += 1) {
      actual.set(
        cell.subarray(y * paddedWidth, (y + 1) * paddedWidth),
        (originY + y) * golden.width + originX,
      );
    }
  }
  // Compare whole pages so golden pixels in cells we left blank also fail.
  let differingPixels = 0;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== golden.pixels[index]) differingPixels += 1;
  }
  const ok = failedGlyphs.length === 0 && differingPixels === 0;
  if (!ok) failedPages += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${file}${differingPixels ? ` differing-px=${differingPixels}` : ""}${failedGlyphs.length ? ` ${failedGlyphs.join(",")}` : ""}`,
  );
}

console.log(
  `[sprite-goldens] pages=${pages.length} failed=${failedPages} glyphs=${renderedGlyphs}`,
);
if (pages.length === 0 || failedPages > 0) process.exit(1);
