/** Where list focus sits: the search field above the rows, or a row by its index. */
export type IssueListFocus = "search" | number;

/**
 * Null when the key is not the list's to handle. The search field and rows read as one column:
 * ArrowDown leaves the field for the first row and ArrowUp on the first row returns to it. Home
 * and End jump within the rows only, because in the field they already move the caret.
 */
export function issueListFocusStep(
  key: string,
  from: IssueListFocus,
  rowCount: number,
): IssueListFocus | null {
  if (rowCount === 0) return null;
  if (from === "search") return key === "ArrowDown" ? 0 : null;
  switch (key) {
    case "ArrowDown":
      return Math.min(from + 1, rowCount - 1);
    case "ArrowUp":
      return from === 0 ? "search" : from - 1;
    case "Home":
      return 0;
    case "End":
      return rowCount - 1;
    default:
      return null;
  }
}
