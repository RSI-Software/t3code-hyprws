import { EnvironmentId, ProjectId, type DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openInNewWindowRequest,
  projectThreadWindowRoute,
  readDesktopProjectWindowRef,
  resolveSidebarBrandTarget,
  supportsDesktopProjectWindows,
} from "./desktopProjectWindows";

describe("supportsDesktopProjectWindows", () => {
  it("hides project-window actions without the desktop bridge method", () => {
    expect(supportsDesktopProjectWindows(undefined)).toBe(false);
    expect(supportsDesktopProjectWindows({} as DesktopBridge)).toBe(false);
  });

  it("recognizes and narrows a desktop window bridge", async () => {
    const requestWindow = vi.fn(async () => undefined);
    const bridge = { requestWindow } as unknown as DesktopBridge;

    expect(supportsDesktopProjectWindows(bridge)).toBe(true);
    if (!supportsDesktopProjectWindows(bridge)) return;

    await bridge.requestWindow({ kind: "new-window" });
    expect(requestWindow).toHaveBeenCalledWith({ kind: "new-window" });
  });
});

describe("openInNewWindowRequest", () => {
  const projectRef = {
    environmentId: EnvironmentId.make("environment:1"),
    projectId: ProjectId.make("project 1"),
  };

  it("opens a project row at its project route, seeded with it", () => {
    expect(openInNewWindowRequest(projectRef)).toEqual({
      kind: "open-in-new-window",
      route: "/project/environment%3A1/project%201",
      seed: projectRef,
    });
  });

  it("opens a thread at its route inside the seeded project", () => {
    expect(
      openInNewWindowRequest(projectRef, projectThreadWindowRoute(projectRef, "thread/1")),
    ).toEqual({
      kind: "open-in-new-window",
      route: "/project/environment%3A1/project%201/thread/thread%2F1",
      seed: projectRef,
    });
  });
});

describe("readDesktopProjectWindowRef", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null without a scoped desktop window", () => {
    expect(readDesktopProjectWindowRef()).toBeNull();

    vi.stubGlobal("window", { desktopBridge: {} as DesktopBridge });
    expect(readDesktopProjectWindowRef()).toBeNull();
  });

  it("reads the project a desktop window is scoped to", () => {
    const projectWindowRef = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };
    vi.stubGlobal("window", { desktopBridge: { projectWindowRef } as DesktopBridge });

    expect(readDesktopProjectWindowRef()).toEqual(projectWindowRef);
  });
});

describe("resolveSidebarBrandTarget", () => {
  it("sends the hub window brand to the thread list", () => {
    expect(resolveSidebarBrandTarget(null)).toEqual({ kind: "hub", label: "Go to threads" });
  });

  it("keeps a project window brand on its own project", () => {
    const projectWindowRef = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };

    expect(resolveSidebarBrandTarget(projectWindowRef)).toEqual({
      kind: "project",
      label: "Go to project",
      ref: projectWindowRef,
    });
  });
});
