// Fork-owned GitHub issue surfaces for the right panel; the upstream store carries only
// marked hook lines. Types arrive as structural mirrors so nothing runtime-shared cycles back
// through the upstream module.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelKind, RightPanelSurface, ThreadRightPanelState } from "./rightPanelStore";

type ThreadUpdater = (current: ThreadRightPanelState) => ThreadRightPanelState;

/** The hub kinds, spread into upstream's ordered kind list: the project's issues and the thread's links. */
export const issueHubKindsFork = ["github-issues", "github-issue-links"] as const;
type IssueHubKindFork = (typeof issueHubKindsFork)[number];

/** A hub tab: one singleton surface per kind, beside any issue tabs. */
export type IssueHubSurfaceFork =
  | { id: "github-issues"; kind: "github-issues" }
  | { id: "github-issue-links"; kind: "github-issue-links" };

export const issueHubSurfaceFork = (kind: IssueHubKindFork): IssueHubSurfaceFork =>
  kind === "github-issues" ? { id: kind, kind } : { id: kind, kind };

/** The `github-issue` member of the upstream `RightPanelSurface` union. */
export interface IssueSurfaceFork {
  id: `github-issue:${string}`;
  kind: "github-issue";
  environmentId: string;
  projectId: string;
  repository: string;
  number: number;
}

interface IssueTargetFork {
  environmentId: string;
  projectId: string;
  repository: string;
  number: number;
}

export function issueSurface(target: IssueTargetFork): IssueSurfaceFork {
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
export const normalizeIssueFork = (surface: IssueSurfaceFork) => {
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
  return [issueSurface(surface)];
};

/** The persisted active-surface fallback for a persisted `github-issue` surface id. */
export const resolveIssueActiveSurfaceIdFork = (
  rawActiveSurfaceId: string | null | undefined,
  surfaces: ReadonlyArray<RightPanelSurface>,
): string | null =>
  rawActiveSurfaceId === "github-issue"
    ? (surfaces.find((surface) => surface.kind === "github-issue")?.id ?? null)
    : null;

/** The store slice's `openIssue` member, as the upstream interface declares it. */
export type OpenIssueFork = (ref: ScopedThreadRef, target: IssueTargetFork) => void;

/**
 * The store slice's `openIssue` member, composed with the store's own helpers. Opening an
 * issue is a user choice, so it goes through the store's `userAction`.
 */
export const createOpenIssue =
  <State>(deps: {
    set: (partial: (state: State) => Partial<State>) => void;
    userAction: (state: State, threadKey: string, updater: ThreadUpdater) => Partial<State>;
  }): OpenIssueFork =>
  (ref, target) => {
    const surface = issueSurface(target);
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
