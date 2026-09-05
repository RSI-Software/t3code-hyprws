import { useParams } from "@tanstack/react-router";
import {
  resolveThreadRouteFamily as baseResolveThreadRouteFamily,
  type ThreadRouteFamily,
} from "../threadRoutes";

/**
 * Fork-owned navigation seam for project-windows route scoping.
 *
 * `threadRoutes.ts` owns the route-family definitions (`hub` vs `project`)
 * and the project-window resolver. This module is the single fork-owned
 * entry point that upstream files call into. The hook centralizes render-time
 * family selection; the resolver supports execution-time reads after awaits.
 * ChatView keeps four navigation calls, CommandPalette three, and the new-thread
 * hook three. These separate upstream lifecycle sites are intentional: one
 * policy boundary does not mean one call or one diff hunk per file.
 * `thread-route-navigation` guards the boundary imports and inline policy.
 *
 * Recheck the selected upstream tag's hooks, lib and router surfaces before
 * retiring this boundary. An equivalent must preserve hub/project dispatch
 * and execution-time params; retire only the original patch pieces it replaces.
 */

export type { ThreadRouteFamily };

export function useThreadRouteFamily(): ThreadRouteFamily {
  return useParams({
    strict: false,
    select: (params) => baseResolveThreadRouteFamily(params),
  });
}

export function resolveThreadRouteFamily(
  params: Parameters<typeof baseResolveThreadRouteFamily>[0],
): ThreadRouteFamily {
  return baseResolveThreadRouteFamily(params);
}
