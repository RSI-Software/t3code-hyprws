import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Outlet: () => "outlet",
    useNavigate: () => vi.fn(),
    useParams: ({ select }: { select: (params: Record<string, string | undefined>) => unknown }) =>
      select(testState.params),
  };
});

// The thread surface pulls ChatView and the diff worker pool into the module
// graph; the layout test only needs to know which branch the route picked.
vi.mock("../components/ThreadRouteView", () => ({
  ThreadRouteView: () => "thread-route-view",
}));

import { Outlet } from "@tanstack/react-router";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { ProjectRouteContent } from "./project.$environmentId.$projectId";

function collectElementTypes(node: unknown, into: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectElementTypes(child, into));
    return into;
  }
  if (!isValidElement(node)) {
    return into;
  }
  into.push(node.type);
  collectElementTypes((node as ReactElement<{ children?: unknown }>).props.children, into);
  return into;
}

describe("ProjectRouteContent", () => {
  beforeEach(() => {
    testState.params = {};
  });

  it("mounts the scoped layout without requiring a live project snapshot", () => {
    const projectRef = scopeProjectRef("env-1" as never, "project-1" as never);

    expect(ProjectRouteContent({ projectRef })).not.toBeNull();
  });

  it("does not mount the layout for an invalid project ref", () => {
    expect(ProjectRouteContent({ projectRef: null })).toBeNull();
  });

  it("renders the outlet when the route carries no thread", () => {
    const projectRef = scopeProjectRef("env-1" as never, "project-1" as never);

    const types = collectElementTypes(ProjectRouteContent({ projectRef }));
    expect(types).toContain(Outlet);
    expect(types).not.toContain(ThreadRouteView);
  });

  it("renders the thread surface inside the scoped layout when the route carries a thread", () => {
    testState.params = { environmentId: "env-1", threadId: "thread-1" };
    const projectRef = scopeProjectRef("env-1" as never, "project-1" as never);

    const types = collectElementTypes(ProjectRouteContent({ projectRef }));
    expect(types).toContain(ThreadRouteView);
    expect(types).not.toContain(Outlet);
  });
});
