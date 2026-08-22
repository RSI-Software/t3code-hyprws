import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { Children, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { ProjectRouteContent } from "./project.$environmentId.$projectId";

describe("ProjectRouteContent", () => {
  it("mounts the scoped layout without requiring a live project snapshot", () => {
    const projectRef = scopeProjectRef("env-1" as never, "project-1" as never);
    const content = ProjectRouteContent({ projectRef }) as ReactElement<{
      readonly children: ReactNode;
    }>;
    const children = Children.toArray(content.props.children);
    const layout = children[1] as ReactElement<{ readonly forcedProjectRef: typeof projectRef }>;

    expect(children).toHaveLength(2);
    expect(layout.type).toBe(AppSidebarLayout);
    expect(layout.props.forcedProjectRef).toEqual(projectRef);
  });

  it("does not mount the layout for an invalid project ref", () => {
    expect(ProjectRouteContent({ projectRef: null })).toBeNull();
  });
});
