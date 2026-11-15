import { IssueListViewFork } from "@t3tools/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  DEFAULT_ISSUE_ORDER,
  NO_ISSUE_NARROWING,
  type IssueListNarrowing,
  type IssueOrder,
} from "./IssueListView.logic";

const DEFAULT_VIEW = {
  order: DEFAULT_ISSUE_ORDER,
  filters: NO_ISSUE_NARROWING,
};

/** Persists the Issues route's list controls across remounts and windows on this device. */
export function useIssueListViewFork() {
  const [view, setView] = useLocalStorage(
    "t3code:github-issues:list-view",
    DEFAULT_VIEW,
    IssueListViewFork,
  );
  const setOrder = (order: IssueOrder) => setView((previous) => ({ ...previous, order }));
  const setNarrowing = (
    filters: IssueListNarrowing | ((previous: IssueListNarrowing) => IssueListNarrowing),
  ) =>
    setView((previous) => ({
      ...previous,
      filters: typeof filters === "function" ? filters(previous.filters) : filters,
    }));
  return { order: view.order, narrowing: view.filters, setOrder, setNarrowing };
}
