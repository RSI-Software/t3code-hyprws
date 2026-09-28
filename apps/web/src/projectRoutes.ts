import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";

export type ProjectRouteParams = Partial<
  Record<"environmentId" | "projectId" | "threadId" | "draftId", string | undefined>
>;

export type ProjectRouteRedirect = "hub" | "project-index" | null;
export type ProjectListRouteKind = "pull-requests" | "issues";

type ProjectListRouteTarget =
  | { readonly to: "/pull-requests" }
  | {
      readonly to: "/project/$environmentId/$projectId/pull-requests";
      readonly params: ScopedProjectRef;
    }
  | { readonly to: "/issues" }
  | { readonly to: "/project/$environmentId/$projectId/issues"; readonly params: ScopedProjectRef };

type PullRequestListRouteTarget = Extract<
  ProjectListRouteTarget,
  { readonly to: "/pull-requests" | "/project/$environmentId/$projectId/pull-requests" }
>;
type IssueListRouteTarget = Exclude<ProjectListRouteTarget, PullRequestListRouteTarget>;

/**
 * The project owning this window, or null everywhere else (hub window, web,
 * mobile). Shared pages such as settings read it to return to the project this
 * window is scoped to instead of the hub route.
 */
export function readDesktopProjectWindowRef(): ScopedProjectRef | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.projectWindowRef ?? null;
}

/** The project this window shows: its route's, else a desktop project window's own. */
export function currentWindowProjectRef(): ScopedProjectRef | null {
  if (typeof window === "undefined") return null;
  return resolveProjectRefFromPathname(window.location.pathname) ?? readDesktopProjectWindowRef();
}

/**
 * A list page's route. A desktop project window stays in its own project even
 * from a shared page such as settings, where the pathname names no project:
 * the hub list would carry it out of its scope, and the desktop closes a
 * project window that leaves its project.
 */
export function listRouteTarget(
  kind: "pull-requests",
  pathnameProjectRef: ScopedProjectRef | null,
): PullRequestListRouteTarget;
export function listRouteTarget(
  kind: "issues",
  pathnameProjectRef: ScopedProjectRef | null,
): IssueListRouteTarget;
export function listRouteTarget(
  kind: ProjectListRouteKind,
  pathnameProjectRef: ScopedProjectRef | null,
): ProjectListRouteTarget {
  const windowProjectRef = pathnameProjectRef ?? readDesktopProjectWindowRef();
  if (kind === "pull-requests") {
    return windowProjectRef === null
      ? { to: "/pull-requests" as const }
      : {
          to: "/project/$environmentId/$projectId/pull-requests" as const,
          params: windowProjectRef,
        };
  }
  return windowProjectRef === null
    ? { to: "/issues" as const }
    : { to: "/project/$environmentId/$projectId/issues" as const, params: windowProjectRef };
}

export function isValidProjectRouteId(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.trim() === value;
}

export function resolveProjectRouteRef(params: ProjectRouteParams): ScopedProjectRef | null {
  if (!isValidProjectRouteId(params.environmentId) || !isValidProjectRouteId(params.projectId)) {
    return null;
  }

  return scopeProjectRef(params.environmentId as never, params.projectId as never);
}

export function resolveProjectRefFromPathname(pathname: string): ScopedProjectRef | null {
  const routePathname = pathname.startsWith("/#/")
    ? pathname.slice(2)
    : pathname.startsWith("#/")
      ? pathname.slice(1)
      : pathname;
  const [, routeFamily, encodedEnvironmentId, encodedProjectId] = routePathname.split("/");
  if (
    routeFamily !== "project" ||
    encodedEnvironmentId === undefined ||
    encodedProjectId === undefined
  ) {
    return null;
  }

  try {
    return resolveProjectRouteRef({
      environmentId: decodeURIComponent(encodedEnvironmentId),
      projectId: decodeURIComponent(encodedProjectId),
    });
  } catch {
    return null;
  }
}

function projectRefsEqual(left: ScopedProjectRef, right: ScopedProjectRef): boolean {
  return left.environmentId === right.environmentId && left.projectId === right.projectId;
}

export type EnvironmentProjectPresence = "pending" | "present" | "absent";

export function resolveProjectAvailabilityRedirect(input: {
  routeRef: ScopedProjectRef | null;
  environmentProjectPresence: EnvironmentProjectPresence;
}): ProjectRouteRedirect {
  if (input.routeRef === null) {
    return "hub";
  }
  if (input.environmentProjectPresence === "absent") {
    return "hub";
  }
  return null;
}

export function resolveProjectContentRedirect(input: {
  routeRef: ScopedProjectRef;
  contentRef: ScopedProjectRef | null;
  contentIdValid: boolean;
}): ProjectRouteRedirect {
  if (!input.contentIdValid) {
    return "project-index";
  }
  if (input.contentRef !== null && !projectRefsEqual(input.routeRef, input.contentRef)) {
    return "project-index";
  }
  return null;
}
