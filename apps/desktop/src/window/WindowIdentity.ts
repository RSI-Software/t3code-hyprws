import {
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
  type WindowScopeSeed,
} from "@t3tools/contracts";

import { type WindowId, windowIdPreloadArgument } from "./WindowId.fork.ts";
import { windowScopeSeedPreloadArgument } from "./WindowScopeSeed.fork.ts";

export type WindowIdentity =
  | { readonly kind: "hub" }
  | { readonly kind: "project"; readonly ref: ScopedProjectRef };

export const HUB_WINDOW_IDENTITY: WindowIdentity = { kind: "hub" };
export function projectWindowIdentity(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): WindowIdentity {
  return { kind: "project", ref: { environmentId, projectId } };
}

export function windowIdentityKey(identity: WindowIdentity): string {
  return identity.kind === "hub"
    ? "hub"
    : `project:${encodeURIComponent(identity.ref.environmentId)}:${encodeURIComponent(identity.ref.projectId)}`;
}

/**
 * The preload arguments main gives a window: its id, and the scope its sidebar
 * starts on, if seeded (a project, or all projects).
 */
export function windowPreloadArguments(windowId: WindowId, scopeSeed?: WindowScopeSeed): string[] {
  return [
    windowIdPreloadArgument(windowId),
    ...(scopeSeed === undefined ? [] : [windowScopeSeedPreloadArgument(scopeSeed)]),
  ];
}
