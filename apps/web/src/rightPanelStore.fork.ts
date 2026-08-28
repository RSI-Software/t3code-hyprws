// Fork-owned GitHub issue surfaces for the right panel (RSI-Software/t3code-hyprws#959).
// The upstream store carries only marked hook lines; the surface shape, the
// persistence migration, the active-surface fallback, and the open action all
// live here. Types arrive as structural mirrors so nothing runtime-shared
// cycles back through the upstream module.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelKind, RightPanelSurface, ThreadRightPanelState } from "./rightPanelStore";

type ThreadUpdater = (current: ThreadRightPanelState) => ThreadRightPanelState;

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

interface GitHubIssueTargetFork {
  environmentId: string;
  projectId: string;
  repository: string;
  number: number;
}

export function githubIssueSurface(target: GitHubIssueTargetFork): GitHubIssueSurfaceFork {
  return {
    id: `github-issue:${encodeURIComponent(target.environmentId)}:${encodeURIComponent(target.projectId)}:${encodeURIComponent(target.repository)}:${target.number}`,
    kind: "github-issue",
    environmentId: target.environmentId,
    projectId: target.projectId,
    repository: target.repository,
    number: target.number,
  };
}

/** Persisted-state migration for a `github-issue` surface: keep it only when every field is valid. */
export const normalizeGitHubIssueFork = (surface: GitHubIssueSurfaceFork) => {
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
export type OpenGitHubIssueFork = (ref: ScopedThreadRef, target: GitHubIssueTargetFork) => void;

/**
 * The store slice's `openGitHubIssue` member, composed with the store's own helpers. Opening an
 * issue is a user choice, so it goes through the store's `userAction`.
 */
export const createOpenGitHubIssue =
  <State>(deps: {
    set: (partial: (state: State) => Partial<State>) => void;
    userAction: (state: State, threadKey: string, updater: ThreadUpdater) => Partial<State>;
  }): OpenGitHubIssueFork =>
  (ref, target) => {
    const surface = githubIssueSurface(target);
    deps.set((state) =>
      deps.userAction(state, scopedThreadKey(ref), (current) => ({
        isOpen: true,
        surfaces: current.surfaces.some((entry) => entry.id === surface.id)
          ? current.surfaces
          : [...current.surfaces, surface],
        activeSurfaceId: surface.id,
      })),
    );
  };

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
