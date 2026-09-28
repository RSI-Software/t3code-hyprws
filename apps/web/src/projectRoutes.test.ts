import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isValidProjectRouteId,
  listRouteTarget,
  resolveProjectAvailabilityRedirect,
  resolveProjectContentRedirect,
  resolveProjectRefFromPathname,
  resolveProjectRouteRef,
} from "./projectRoutes";

const PROJECT_REF = scopeProjectRef("env-1" as never, "project-1" as never);

describe("projectRoutes", () => {
  it("parses a complete physical project ref from route params", () => {
    expect(resolveProjectRouteRef(PROJECT_REF)).toEqual(PROJECT_REF);
  });

  it("parses encoded physical project refs from browser and desktop route pathnames", () => {
    const expectedRef = scopeProjectRef("remote:wsl" as never, "project one" as never);

    expect(
      resolveProjectRefFromPathname("/project/remote%3Awsl/project%20one/thread/thread-1"),
    ).toEqual(expectedRef);
    expect(resolveProjectRefFromPathname("#/project/remote%3Awsl/project%20one")).toEqual(
      expectedRef,
    );
    expect(resolveProjectRefFromPathname("/#/project/remote%3Awsl/project%20one")).toEqual(
      expectedRef,
    );
  });

  it("rejects non-project, incomplete, empty, untrimmed, and malformed pathnames", () => {
    expect(resolveProjectRefFromPathname("/")).toBeNull();
    expect(resolveProjectRefFromPathname("/project/env-1")).toBeNull();
    expect(resolveProjectRefFromPathname("/project//project-1")).toBeNull();
    expect(resolveProjectRefFromPathname("/project/%20env-1/project-1")).toBeNull();
    expect(resolveProjectRefFromPathname("/project/%E0%A4%A/project-1")).toBeNull();
  });

  it("rejects missing, empty, and untrimmed route ids", () => {
    expect(resolveProjectRouteRef({ environmentId: "env-1" })).toBeNull();
    expect(resolveProjectRouteRef({ environmentId: "env-1", projectId: "" })).toBeNull();
    expect(resolveProjectRouteRef({ environmentId: " env-1", projectId: "project-1" })).toBeNull();
    expect(isValidProjectRouteId(" ")).toBe(false);
  });

  it("redirects invalid refs and authoritatively absent projects to the hub", () => {
    expect(
      resolveProjectAvailabilityRedirect({
        routeRef: null,
        environmentProjectPresence: "pending",
      }),
    ).toBe("hub");
    expect(
      resolveProjectAvailabilityRedirect({
        routeRef: PROJECT_REF,
        environmentProjectPresence: "absent",
      }),
    ).toBe("hub");
  });

  it("waits through cold-load shell and project-projection population", () => {
    const coldLoadDecisions = [
      resolveProjectAvailabilityRedirect({
        routeRef: PROJECT_REF,
        environmentProjectPresence: "pending",
      }),
      resolveProjectAvailabilityRedirect({
        routeRef: PROJECT_REF,
        environmentProjectPresence: "present",
      }),
    ];

    expect(coldLoadDecisions).toEqual([null, null]);
  });

  it("redirects invalid and mismatched scoped content to the project index", () => {
    expect(
      resolveProjectContentRedirect({
        routeRef: PROJECT_REF,
        contentRef: null,
        contentIdValid: false,
      }),
    ).toBe("project-index");
    expect(
      resolveProjectContentRedirect({
        routeRef: PROJECT_REF,
        contentRef: scopeProjectRef("env-1" as never, "project-2" as never),
        contentIdValid: true,
      }),
    ).toBe("project-index");
  });

  describe("list routes", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("keeps a desktop project window's lists in its project from a shared page", () => {
      vi.stubGlobal("window", { desktopBridge: { projectWindowRef: PROJECT_REF } });
      expect(listRouteTarget("issues", null)).toEqual({
        to: "/project/$environmentId/$projectId/issues",
        params: PROJECT_REF,
      });
      expect(listRouteTarget("pull-requests", null)).toEqual({
        to: "/project/$environmentId/$projectId/pull-requests",
        params: PROJECT_REF,
      });
    });

    it("sends the hub and the web client to the all-projects lists", () => {
      expect(listRouteTarget("issues", null)).toEqual({ to: "/issues" });
      vi.stubGlobal("window", { desktopBridge: { projectWindowRef: null } });
      expect(listRouteTarget("pull-requests", null)).toEqual({ to: "/pull-requests" });
    });
  });
});
