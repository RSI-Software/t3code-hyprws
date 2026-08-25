import type { WindowProjectScopeParam } from "../../windowProjectScope";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
} from "@t3tools/contracts";

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
  readonly scope?: WindowProjectScopeParam;
}

export function validatePullRequestsSearch(raw: Record<string, unknown>): PullRequestsSearch {
  return {
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state:
      raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open",
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
    ...(raw.scope === "all" ? { scope: raw.scope } : {}),
  };
}
