import {
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
  type WindowScopeSeed,
} from "@t3tools/contracts";

import {
  projectWindowPreloadArgument,
  readProjectWindowPreloadParts,
} from "./projectWindowArgument.ts";
import { type WindowId, windowIdPreloadArgument } from "./WindowId.fork.ts";
import { windowScopeSeedPreloadArgument } from "./WindowScopeSeed.fork.ts";

export {
  PROJECT_WINDOW_PRELOAD_ARGUMENT,
  isProjectWindowPreload,
  projectWindowPreloadArgument,
} from "./projectWindowArgument.ts";

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
 * The preload arguments main gives a window: its id, the project it shows, if
 * any, and the scope its sidebar starts on, if seeded (a project, or all projects).
 */
export function windowPreloadArguments(
  identity: WindowIdentity,
  windowId: WindowId,
  scopeSeed?: WindowScopeSeed,
): string[] {
  return [
    windowIdPreloadArgument(windowId),
    ...(identity.kind === "project" ? [projectWindowPreloadArgument(identity.ref)] : []),
    ...(scopeSeed === undefined ? [] : [windowScopeSeedPreloadArgument(scopeSeed)]),
  ];
}

export function readProjectWindowPreloadRef(argv: readonly string[]): ScopedProjectRef | null {
  const parts = readProjectWindowPreloadParts(argv);
  return parts === null
    ? null
    : {
        environmentId: EnvironmentId.make(parts.environmentId),
        projectId: ProjectId.make(parts.projectId),
      };
}
