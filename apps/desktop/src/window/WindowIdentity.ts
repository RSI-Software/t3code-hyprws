import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";

import { readProjectWindowPreloadParts } from "./projectWindowArgument.ts";

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

export function windowIdentityEquals(left: WindowIdentity, right: WindowIdentity): boolean {
  return windowIdentityKey(left) === windowIdentityKey(right);
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
