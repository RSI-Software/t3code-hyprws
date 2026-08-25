import type { WindowProjectScopeParam } from "../../windowProjectScope";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
} from "@t3tools/contracts";

/** Sort orders the list header offers. The route's `SORT_OPTIONS` renders these. */
export const PULL_REQUEST_LIST_SORTS = [
  "updated",
  "newest",
  "oldest",
  "largest",
  "smallest",
] as const;
export type PullRequestListSort = (typeof PULL_REQUEST_LIST_SORTS)[number];

/** Upstream caps how many raw label values it will even look at before deduping. */
const MAX_SEARCH_LABEL_CANDIDATES = 100;
const MAX_SEARCH_LABELS = 10;

function pullRequestSearchLabels(raw: unknown): Partial<Pick<PullRequestsSearch, "labels">> {
  const values = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).slice(
    0,
    MAX_SEARCH_LABEL_CANDIDATES,
  );
  const labels: Array<string> = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim().slice(0, 200);
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) continue;
    labels.push(value);
    seen.add(key);
    if (labels.length === MAX_SEARCH_LABELS) break;
  }
  return labels.length === 0 ? {} : { labels };
}

export interface PullRequestsSearch {
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
  /** Narrows the list to one server. Absent means every connected server. */
  readonly environmentId?: EnvironmentId;
  /** Hub-only explicit project filter. Project routes use their route parameters instead. */
  readonly projectId?: ProjectId;
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly q?: string;
  readonly draft?: "only" | "hide";
  readonly review?: NonNullable<PullRequestListFilters["review"]>;
  readonly checks?: NonNullable<PullRequestListFilters["checks"]>;
  readonly author?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly sort?: PullRequestListSort;
  readonly scope?: WindowProjectScopeParam;
}

export function validatePullRequestsSearch(raw: Record<string, unknown>): PullRequestsSearch {
  return {
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state:
      raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open",
    ...(PULL_REQUEST_LIST_SORTS.some((sort) => sort === raw.sort)
      ? { sort: raw.sort as PullRequestListSort }
      : {}),
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.host === "string" && raw.host ? { host: raw.host.slice(0, 200) } : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.selectedEnvironmentId === "string" && raw.selectedEnvironmentId
      ? { selectedEnvironmentId: raw.selectedEnvironmentId as EnvironmentId }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
    ...(raw.draft === "only" || raw.draft === "hide" ? { draft: raw.draft } : {}),
    ...(raw.review === "approved" ||
    raw.review === "changes-requested" ||
    raw.review === "review-required" ||
    raw.review === "none"
      ? { review: raw.review }
      : {}),
    ...(raw.checks === "passing" || raw.checks === "failing" ? { checks: raw.checks } : {}),
    ...(typeof raw.author === "string" && raw.author.trim()
      ? { author: raw.author.trim().slice(0, 200) }
      : {}),
    ...pullRequestSearchLabels(raw.labels),
    ...(raw.scope === "all" ? { scope: raw.scope } : {}),
  };
}
