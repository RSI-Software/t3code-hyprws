# Thread route navigation

> Fork-only. Part of the `project-windows` domain in [Fork delta](./fork-delta.md).

The hub renders every project at `/$environmentId/$threadId`. A project window renders one
project at `/project/$environmentId/$projectId/thread/$threadId`. Every thread navigation has
to land in the window it was issued from, so no upstream chat file may hardcode a route.

`apps/web/src/threadRoutes.ts` defines the two route families and `resolveThreadRouteFamily`.
`apps/web/src/lib/threadRouteNavigation.ts` is the fork-owned boundary upstream files import:

| Export                                           | Use it when                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `useThreadRouteFamily()`                         | A component picks the family at render time.                                                     |
| `resolveThreadRouteFamily(params)`               | A callback resolves the family after awaited work.                                               |
| `resolveThreadRouteDeparture(params, threadRef)` | A callback leaves the current thread and falls back to the family index when no thread survives. |

The `thread-route-navigation` authoring guard in `scripts/fork-scan-guards.ts` blocks direct
`threadRoutes` resolver imports and inline family policy from returning to the guarded files.

## Call-site budget

A single policy boundary does not mean one call or one diff hunk per upstream file. Upstream
owns where navigation happens; the fork owns only which family it targets. Each upstream file
therefore spends **one boundary call per distinct upstream navigation event**, plus one hook
call when it selects at render time.

| Upstream file                                | Boundary calls | The events they serve                                                                          |
| -------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `apps/web/src/components/ChatView.tsx`       | 1 hook + 4     | restore a stored draft, open a new draft, open a background thread, advance to the next thread |
| `apps/web/src/components/CommandPalette.tsx` | 1 hook + 3     | jump to the latest thread, open a searched thread, resume the latest thread from a project row |
| `apps/web/src/hooks/useHandleNewThread.ts`   | 3              | the created draft, a raced draft, the settled draft id                                         |
| `apps/web/src/hooks/useThreadActions.ts`     | 1              | leave a deleted thread for its fallback                                                        |

Adding a call means an upstream navigation event gained a route target; edit the table in the
same change. Collapsing two calls is only correct when the events themselves merged upstream —
`useThreadActions.ts` went from three calls to one that way, because upstream `.1290` computes
one `fallbackThread` and branches once.

The hooks read router params at execution time on purpose. A navigation that awaits first would
otherwise resolve against the params captured when the component rendered and could leave a
project window for the hub.

## Retirement

Upstream has no route-family concept, so nothing retires this boundary yet. Before each carry,
re-read the selected tag's `apps/web/src/threadRoutes.ts`, `apps/web/src/hooks`, and router
surfaces. An upstream equivalent has to preserve hub/project dispatch and execution-time
parameter reads; adopting one retires only the patch pieces it actually replaces.
