import { describe, expect, it } from "vite-plus/test";

import { disambiguateTerminalLabels, splitTerminalLabelSuffix } from "./terminalLabels.ts";

describe("disambiguateTerminalLabels", () => {
  const labels = (entries: ReadonlyArray<readonly [string, string]>) =>
    disambiguateTerminalLabels(new Map(entries));

  it("leaves a lone terminal unsuffixed", () => {
    expect(labels([["term-1", "uat-sample/main"]]).get("term-1")).toBe("uat-sample/main");
  });

  it("leaves distinct labels unsuffixed", () => {
    const result = labels([
      ["term-1", "uat-sample/main"],
      ["term-2", "uat-sample/feature"],
    ]);
    expect(result.get("term-1")).toBe("uat-sample/main");
    expect(result.get("term-2")).toBe("uat-sample/feature");
  });

  it("suffixes duplicates with their terminal id number", () => {
    const result = labels([
      ["term-1", "uat-sample/main"],
      ["term-2", "uat-sample/main"],
      ["term-3", "uat-sample/main"],
    ]);
    expect(result.get("term-1")).toBe("uat-sample/main");
    expect(result.get("term-2")).toBe("uat-sample/main·2");
    expect(result.get("term-3")).toBe("uat-sample/main·3");
  });

  it("does not renumber survivors when a sibling closes", () => {
    // term-2 closed: term-3 keeps ·3 instead of sliding down to ·2.
    const result = labels([
      ["term-1", "uat-sample/main"],
      ["term-3", "uat-sample/main"],
    ]);
    expect(result.get("term-1")).toBe("uat-sample/main");
    expect(result.get("term-3")).toBe("uat-sample/main·3");
  });

  it("keeps suffixes stable when strip order changes", () => {
    const mruFirst = labels([
      ["term-3", "uat-sample/main"],
      ["term-1", "uat-sample/main"],
      ["term-2", "uat-sample/main"],
    ]);
    expect(mruFirst.get("term-1")).toBe("uat-sample/main");
    expect(mruFirst.get("term-2")).toBe("uat-sample/main·2");
    expect(mruFirst.get("term-3")).toBe("uat-sample/main·3");
  });

  it("falls back to sequential indexes for ids without a number", () => {
    const result = labels([
      ["custom-a", "uat-sample/main"],
      ["custom-b", "uat-sample/main"],
    ]);
    expect(result.get("custom-a")).toBe("uat-sample/main");
    expect(result.get("custom-b")).toBe("uat-sample/main·2");
  });

  it("disambiguates collision groups independently", () => {
    const result = labels([
      ["term-1", "uat-sample/main"],
      ["term-2", "uat-sample/main"],
      ["term-3", "uat-sample/feature"],
    ]);
    expect(result.get("term-1")).toBe("uat-sample/main");
    expect(result.get("term-2")).toBe("uat-sample/main·2");
    expect(result.get("term-3")).toBe("uat-sample/feature");
  });
});

describe("splitTerminalLabelSuffix", () => {
  it("splits a disambiguated label into base and suffix", () => {
    expect(splitTerminalLabelSuffix("uat-sample/main·2")).toEqual({
      base: "uat-sample/main",
      suffix: "·2",
    });
  });

  it("returns an empty suffix for an undisambiguated label", () => {
    expect(splitTerminalLabelSuffix("uat-sample/main")).toEqual({
      base: "uat-sample/main",
      suffix: "",
    });
  });
});
