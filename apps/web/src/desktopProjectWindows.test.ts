import { EnvironmentId, ProjectId, type DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readDesktopProjectWindowRef,
  resolveSidebarBrandTarget,
  supportsDesktopProjectWindows,
} from "./desktopProjectWindows";

describe("supportsDesktopProjectWindows", () => {
  it("hides project-window actions without the desktop bridge method", () => {
    expect(supportsDesktopProjectWindows(undefined)).toBe(false);
    expect(supportsDesktopProjectWindows({} as DesktopBridge)).toBe(false);
  });

  it("recognizes and narrows a desktop project-window bridge", async () => {
    const openProjectWindow = vi.fn(async () => undefined);
    const bridge = { openProjectWindow } as unknown as DesktopBridge;

    expect(supportsDesktopProjectWindows(bridge)).toBe(true);
    if (!supportsDesktopProjectWindows(bridge)) return;

    const projectRef = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };
    await bridge.openProjectWindow(projectRef);
    expect(openProjectWindow).toHaveBeenCalledWith(projectRef);
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

  // The hub route is outside a project window's scope, so the desktop guard
  // closes the window on the way there. The brand stays inside the window.
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
