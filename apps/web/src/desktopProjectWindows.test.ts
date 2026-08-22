import { EnvironmentId, ProjectId, type DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { supportsDesktopProjectWindows } from "./desktopProjectWindows";

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
