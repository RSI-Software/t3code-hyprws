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
 * entry point that upstream files call into. Centralising the `useParams`
 * indirection here keeps each of `ChatView.tsx`, `CommandPalette.tsx`, and
 * `useHandleNewThread.ts` to one seam (one hook call) instead of spreading
 * `resolveThreadRouteFamily` + `useParams`/`router.state` across the domain.
 *
 * Upstream has no equivalent helper (`apps/web/src/hooks`, `apps/web/src/lib`,
 * and router surface checked 2026-09-03: no navigation family helper exists
 * on `upstream/main`). If upstream adds one, this module becomes a thin
 * re-export and the original `refactor(web): centralize thread route
 * navigation` commit can retire.
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
