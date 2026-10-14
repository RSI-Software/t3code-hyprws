import { GitHubIssueListViewFork } from "@t3tools/contracts";
import { useCallback } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  DEFAULT_GITHUB_ISSUE_ORDER,
  NO_GITHUB_ISSUE_NARROWING,
  type GitHubIssueListNarrowing,
  type GitHubIssueOrder,
} from "./GitHubIssueListView.logic";

const DEFAULT_VIEW = {
  order: DEFAULT_GITHUB_ISSUE_ORDER,
  filters: NO_GITHUB_ISSUE_NARROWING,
};

/** Persists the Issues route's list controls across remounts and windows on this device. */
export function useGitHubIssueListViewFork() {
  const [view, setView] = useLocalStorage(
    "t3code:github-issues:list-view",
    DEFAULT_VIEW,
    GitHubIssueListViewFork,
  );
  const setOrder = useCallback(
    (order: GitHubIssueOrder) => setView((previous) => ({ ...previous, order })),
    [setView],
  );
  const setNarrowing = useCallback(
    (
      filters:
        | GitHubIssueListNarrowing
        | ((previous: GitHubIssueListNarrowing) => GitHubIssueListNarrowing),
    ) =>
      setView((previous) => ({
        ...previous,
        filters: typeof filters === "function" ? filters(previous.filters) : filters,
      })),
    [setView],
  );
  return { order: view.order, narrowing: view.filters, setOrder, setNarrowing };
}
