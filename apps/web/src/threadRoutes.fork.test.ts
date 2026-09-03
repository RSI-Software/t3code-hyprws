import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import { resolveThreadRouteFamily } from "./threadRoutes";

describe("threadRoutes", () => {
  it("resolves hub thread, draft, and missing-route navigation through one family", () => {
    const family = resolveThreadRouteFamily({});

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

  it("resolves project thread, draft, and index navigation from scoped params", () => {
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

  it("falls back to the hub family for incomplete project params", () => {
    expect(resolveThreadRouteFamily({ environmentId: "env-1" }).kind).toBe("hub");
    expect(resolveThreadRouteFamily({ projectId: "project-1" }).kind).toBe("hub");
  });
});
