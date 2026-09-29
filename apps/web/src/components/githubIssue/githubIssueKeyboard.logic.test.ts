import { describe, expect, it } from "vite-plus/test";

import { gitHubIssueListFocusStep } from "./githubIssueKeyboard.logic";

describe("gitHubIssueListFocusStep", () => {
  it("steps from the search field into the first row and back", () => {
    expect(gitHubIssueListFocusStep("ArrowDown", "search", 3)).toBe(0);
    expect(gitHubIssueListFocusStep("ArrowUp", 0, 3)).toBe("search");
  });

  it("clamps at the last row", () => {
    expect(gitHubIssueListFocusStep("ArrowDown", 1, 3)).toBe(2);
    expect(gitHubIssueListFocusStep("ArrowDown", 2, 3)).toBe(2);
  });

  it("jumps to either end from a row, but leaves Home and End to the field's caret", () => {
    expect(gitHubIssueListFocusStep("Home", 2, 3)).toBe(0);
    expect(gitHubIssueListFocusStep("End", 0, 3)).toBe(2);
    expect(gitHubIssueListFocusStep("Home", "search", 3)).toBeNull();
    expect(gitHubIssueListFocusStep("ArrowUp", "search", 3)).toBeNull();
  });

  it("handles nothing when there are no rows or the key is not a list key", () => {
    expect(gitHubIssueListFocusStep("ArrowDown", "search", 0)).toBeNull();
    expect(gitHubIssueListFocusStep("Enter", 1, 3)).toBeNull();
  });
});
