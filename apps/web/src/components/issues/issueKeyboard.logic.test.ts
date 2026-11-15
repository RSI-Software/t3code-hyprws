import { describe, expect, it } from "vite-plus/test";

import { issueListFocusStep } from "./issueKeyboard.logic";

describe("issueListFocusStep", () => {
  it("steps from the search field into the first row and back", () => {
    expect(issueListFocusStep("ArrowDown", "search", 3)).toBe(0);
    expect(issueListFocusStep("ArrowUp", 0, 3)).toBe("search");
  });

  it("clamps at the last row", () => {
    expect(issueListFocusStep("ArrowDown", 1, 3)).toBe(2);
    expect(issueListFocusStep("ArrowDown", 2, 3)).toBe(2);
  });

  it("jumps to either end from a row, but leaves Home and End to the field's caret", () => {
    expect(issueListFocusStep("Home", 2, 3)).toBe(0);
    expect(issueListFocusStep("End", 0, 3)).toBe(2);
    expect(issueListFocusStep("Home", "search", 3)).toBeNull();
    expect(issueListFocusStep("ArrowUp", "search", 3)).toBeNull();
  });

  it("handles nothing when there are no rows or the key is not a list key", () => {
    expect(issueListFocusStep("ArrowDown", "search", 0)).toBeNull();
    expect(issueListFocusStep("Enter", 1, 3)).toBeNull();
  });
});
