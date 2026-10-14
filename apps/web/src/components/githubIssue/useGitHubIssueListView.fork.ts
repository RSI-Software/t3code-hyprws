import { GitHubIssueListViewFork } from "@t3tools/contracts";

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
  const setOrder = (order: GitHubIssueOrder) => setView((previous) => ({ ...previous, order }));
  const setNarrowing = (
    filters:
      | GitHubIssueListNarrowing
      | ((previous: GitHubIssueListNarrowing) => GitHubIssueListNarrowing),
  ) =>
    setView((previous) => ({
      ...previous,
      filters: typeof filters === "function" ? filters(previous.filters) : filters,
    }));
  return { order: view.order, narrowing: view.filters, setOrder, setNarrowing };
}
