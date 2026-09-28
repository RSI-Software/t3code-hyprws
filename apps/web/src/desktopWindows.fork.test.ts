import { EnvironmentId, ProjectId, ThreadId, type DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openInNewWindowRequest,
  openThreadInNewWindow,
  supportsDesktopProjectWindows,
} from "./desktopWindows.fork";

describe("supportsDesktopProjectWindows", () => {
  it("hides window actions without the desktop bridge method", () => {
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

  it("opens a project row at the ordinary home route, seeded with it", () => {
    expect(openInNewWindowRequest(projectRef)).toEqual({
      kind: "open-in-new-window",
      route: "/",
      seed: projectRef,
    });
  });
});

describe("openThreadInNewWindow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the thread at its ordinary thread route, seeded with its project", () => {
    const requestWindow = vi.fn(async () => undefined);
    vi.stubGlobal("window", { desktopBridge: { requestWindow } as unknown as DesktopBridge });

    openThreadInNewWindow(
      {
        environmentId: EnvironmentId.make("environment:1"),
        threadId: ThreadId.make("thread/1"),
      },
      ProjectId.make("project 1"),
    );

    expect(requestWindow).toHaveBeenCalledWith({
      kind: "open-in-new-window",
      route: "/environment%3A1/thread%2F1",
      seed: {
        environmentId: EnvironmentId.make("environment:1"),
        projectId: ProjectId.make("project 1"),
      },
    });
  });
});
