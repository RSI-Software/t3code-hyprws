import { describe, expect, it } from "vite-plus/test";

import { colorSwatchStyle } from "./colorSwatch.fork";

describe("colorSwatchStyle", () => {
  it("accepts one colour and nothing that could extend the style", () => {
    const accepted = ["#0969DA", "#fff", "rgb(9, 105, 218)", "hsla(212, 92%, 45%, 0.5)"];
    const rejected = ["#zzz", "#12345", "red", "rgb(1, 2, 3); background: url(x)", "rgb(x)"];
    expect(accepted.map((text) => colorSwatchStyle(text) !== null)).toEqual(
      accepted.map(() => true),
    );
    expect(rejected.map(colorSwatchStyle)).toEqual(rejected.map(() => null));
  });
});
