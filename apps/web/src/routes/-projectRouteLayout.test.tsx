import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { ProjectRouteContent } from "./project.$environmentId.$projectId";

describe("ProjectRouteContent", () => {
  it("mounts the scoped layout without requiring a live project snapshot", () => {
    const projectRef = scopeProjectRef("env-1" as never, "project-1" as never);

    expect(ProjectRouteContent({ projectRef })).not.toBeNull();
  });

  it("does not mount the layout for an invalid project ref", () => {
    expect(ProjectRouteContent({ projectRef: null })).toBeNull();
  });
});
