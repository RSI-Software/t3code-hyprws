// Fork-owned right-panel Agents surface logic (RSI-Software/t3code-hyprws#674).
// The openAgents store member's body was woven into rightPanelStore.ts; the
// upstream file keeps only the marked interface declaration and one marked
// call. Types arrive as structural mirrors so nothing runtime-shared cycles
// back through the upstream module.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelKind, RightPanelSurface, ThreadRightPanelState } from "./rightPanelStore";

type ByThreadKey = Record<string, ThreadRightPanelState>;
type ThreadUpdater = (current: ThreadRightPanelState) => ThreadRightPanelState;

const replaceSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
): ThreadRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
    : [...current.surfaces, surface],
  activeSurfaceId: surface.id,
});

/** The store slice's `openAgents` member, composed with the store's own helpers. */
export const createOpenAgents =
  (deps: {
    set: (partial: (state: { byThreadKey: ByThreadKey }) => { byThreadKey: ByThreadKey }) => void;
    updateThread: (
      byThreadKey: ByThreadKey,
      threadKey: string,
      updater: ThreadUpdater,
    ) => ByThreadKey;
  }): ((
    ref: ScopedThreadRef,
    target?:
      | {
          readonly selectedAgentId?: string | null;
          readonly rosterFocusAgentId?: string | null;
        }
      | undefined,
  ) => void) =>
  (ref, target) =>
    deps.set((state) => ({
      byThreadKey: deps.updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
        replaceSurface(current, {
          id: "agents",
          kind: "agents",
          selectedAgentId: target?.selectedAgentId ?? null,
          rosterFocusAgentId: target?.rosterFocusAgentId ?? null,
        }),
      ),
    }));

// ---------------------------------------------------------------------------
// GitHub issue surfaces (RSI-Software/t3code-hyprws#959, commit `9f92309411`).
// The upstream store carries only marked hook lines; the surface shape, the
// persistence migration, the active-surface fallback, and the open action all
// live here.
// ---------------------------------------------------------------------------

/** The `github-issues` hub kind, spread into upstream's ordered kind list. */
export const githubIssueHubKindsFork = ["github-issues"] as const;

/** The hub tab: one singleton surface listing the project's issues beside any issue tabs. */
export interface GitHubIssueHubSurfaceFork {
  id: "github-issues";
  kind: "github-issues";
}

export const githubIssueHubSurfaceFork = (): GitHubIssueHubSurfaceFork => ({
  id: "github-issues",
  kind: "github-issues",
});

/** The `github-issue` member of the upstream `RightPanelSurface` union. */
export interface GitHubIssueSurfaceFork {
  id: `github-issue:${string}`;
  kind: "github-issue";
  environmentId: string;
  projectId: string;
  repository: string;
  number: number;
}

const githubIssueSurfaceId = (target: {
  environmentId: string;
  projectId: string;
  repository: string;
  number: number;
}): GitHubIssueSurfaceFork["id"] =>
  `github-issue:${encodeURIComponent(target.environmentId)}:${encodeURIComponent(target.projectId)}:${encodeURIComponent(target.repository)}:${target.number}`;

export function githubIssueSurface(target: {
  environmentId: string;
  projectId: string;
  repository: string;
  number: number;
}): GitHubIssueSurfaceFork {
  return {
    id: githubIssueSurfaceId(target),
    kind: "github-issue",
    environmentId: target.environmentId,
    projectId: target.projectId,
    repository: target.repository,
    number: target.number,
  };
}

/**
 * A pull-request tab's status map with one entry set. Keyed by the surface the panel is showing
 * rather than by a key rebuilt from the status, so the tab is found again whether or not that
 * surface was opened with an environment on it. Returns the same map when the tab's own fields
 * have not changed, so a caller can skip a re-render.
 */
export function updatePullRequestTabStatus<Status extends { state: unknown; isDraft: boolean }>(
  statuses: Readonly<Record<string, Status>>,
  surfaceId: string,
  status: Status,
): Readonly<Record<string, Status>> {
  return statuses[surfaceId]?.state === status.state &&
    statuses[surfaceId]?.isDraft === status.isDraft
    ? statuses
    : { ...statuses, [surfaceId]: status };
}

/** Persisted-state migration for a `github-issue` surface: keep it only when every field is valid. */
export const normalizeGitHubIssueSurfaceFork = (surface: GitHubIssueSurfaceFork) => {
  if (
    typeof surface.environmentId !== "string" ||
    surface.environmentId.length === 0 ||
    typeof surface.projectId !== "string" ||
    surface.projectId.length === 0 ||
    typeof surface.repository !== "string" ||
    surface.repository.length === 0 ||
    typeof surface.number !== "number" ||
    !Number.isSafeInteger(surface.number) ||
    surface.number < 1
  ) {
    return [];
  }
  return [githubIssueSurface(surface)];
};

/** The persisted active-surface fallback for a persisted `github-issue` surface id. */
export const resolveGitHubIssueActiveSurfaceIdFork = (
  rawActiveSurfaceId: string | null | undefined,
  surfaces: ReadonlyArray<RightPanelSurface>,
): string | null =>
  rawActiveSurfaceId === "github-issue"
    ? (surfaces.find((surface) => surface.kind === "github-issue")?.id ?? null)
    : null;

/** The store slice's `openGitHubIssue` member, as the upstream interface declares it. */
export type OpenGitHubIssueFork = (
  ref: ScopedThreadRef,
  target: {
    environmentId: string;
    projectId: string;
    repository: string;
    number: number;
  },
) => void;

/** The store slice's `openGitHubIssue` member, composed with the store's own helpers. */
export const createOpenGitHubIssue =
  (deps: {
    set: (partial: (state: { byThreadKey: ByThreadKey }) => { byThreadKey: ByThreadKey }) => void;
    updateThread: (
      byThreadKey: ByThreadKey,
      threadKey: string,
      updater: ThreadUpdater,
    ) => ByThreadKey;
  }): OpenGitHubIssueFork =>
  (ref, target) =>
    deps.set((state) => ({
      byThreadKey: deps.updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
        isOpen: true,
        surfaces: current.surfaces.some((entry) => entry.id === githubIssueSurface(target).id)
          ? current.surfaces
          : [...current.surfaces, githubIssueSurface(target)],
        activeSurfaceId: githubIssueSurface(target).id,
      })),
    }));

/**
 * The upstream `selectActiveRightPanel` return, narrowed back to the upstream
 * `RightPanelKind`: the fork surface member's `kind` is not an openable panel
 * kind, so it is dropped here instead of widening the upstream signature.
 */
export const selectActiveRightPanelKindFork = (state: {
  surfaces: ReadonlyArray<RightPanelSurface>;
  activeSurfaceId: string | null;
}): RightPanelKind | null =>
  (state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ??
    null) as RightPanelKind | null;
