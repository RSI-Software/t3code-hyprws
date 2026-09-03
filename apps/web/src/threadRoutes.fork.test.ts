import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import { resolveThreadRouteFamily } from "./lib/threadRouteNavigation";

/**
 * Fork-owned sibling of `threadRoutes.test.ts`.
 *
 * Upstream owns `threadRoutes.test.ts` and does not know about project-window
 * route scoping. Fork cases that prove hub vs project selection stay here so
 * the upstream file takes upstream edits cleanly. `lib/threadRouteNavigation.ts`
 * is the single fork-owned entry point that the three busy upstream files call
 * into, keeping each to one seam.
 *
 * `threadRoutes` on `hyprws` also carries the same hub/project family tests
 * (from `d754f4111f`), but those import from `./threadRoutes` directly. This
 * file proves the same decisions through the fork hook itself.
 */

describe("threadRouteNavigation fork seam", () => {
  it("selects the hub family when no project params are present", () => {
    const family = resolveThreadRouteFamily({});

    expect(family.kind).toBe("hub");
    expect(family.thread(scopeThreadRef("env-1" as never, ThreadId.make("thread-1")))).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(family.draft(DraftId.make("draft-1"))).toEqual({
      to: "/draft/$draftId",
      params: { draftId: "draft-1" },
    });
    expect(family.index()).toEqual({ to: "/" });
  });

  it("selects the project family when the route carries a project id", () => {
    const family = resolveThreadRouteFamily({
      environmentId: "env-1",
      projectId: "project-1",
    });

    expect(family.kind).toBe("project");
    expect(family.thread(scopeThreadRef("env-1" as never, ThreadId.make("thread-1")))).toEqual({
      to: "/project/$environmentId/$projectId/thread/$threadId",
      params: {
        environmentId: "env-1",
        projectId: "project-1",
        threadId: "thread-1",
      },
    });
    expect(family.draft(DraftId.make("draft-1"))).toEqual({
      to: "/project/$environmentId/$projectId/draft/$draftId",
      params: {
        environmentId: "env-1",
        projectId: "project-1",
        draftId: "draft-1",
      },
    });
    expect(family.index()).toEqual({
      to: "/project/$environmentId/$projectId",
      params: { environmentId: "env-1", projectId: "project-1" },
    });
  });

  it("falls back to hub when project params are incomplete", () => {
    expect(resolveThreadRouteFamily({ environmentId: "env-1" }).kind).toBe("hub");
    expect(resolveThreadRouteFamily({ projectId: "project-1" }).kind).toBe("hub");
    expect(resolveThreadRouteFamily({}).kind).toBe("hub");
  });
});
