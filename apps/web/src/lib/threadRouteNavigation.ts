import { useParams } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
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
 * family selection; the resolvers support execution-time reads after awaits.
 * One policy boundary does not mean one call or one diff hunk per file: an
 * upstream consumer spends one call per distinct navigation event, and
 * `docs/internals/thread-route-navigation.md` holds that budget.
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

/**
 * Resolves one "leave the thread I am on" navigation into route options for the
 * family the caller is currently in, falling back to that family's index when no
 * thread survives. Callers pass params read at execution time, so a navigation
 * that awaits first still lands in the window it was issued from.
 */
export function resolveThreadRouteDeparture(
  params: Parameters<typeof baseResolveThreadRouteFamily>[0],
  threadRef: ScopedThreadRef | null,
) {
  const family = baseResolveThreadRouteFamily(params);
  return threadRef ? family.thread(threadRef) : family.index();
}
