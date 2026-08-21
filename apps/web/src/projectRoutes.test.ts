import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import {
  isValidProjectRouteId,
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

  it("parses encoded physical project refs from scoped pathnames", () => {
    expect(
      resolveProjectRefFromPathname("/project/remote%3Awsl/project%20one/thread/thread-1"),
    ).toEqual(scopeProjectRef("remote:wsl" as never, "project one" as never));
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

  it("redirects invalid and unknown project refs to the hub", () => {
    expect(
      resolveProjectAvailabilityRedirect({
        routeRef: null,
        bootstrapComplete: false,
        projectExists: false,
      }),
    ).toBe("hub");
    expect(
      resolveProjectAvailabilityRedirect({
        routeRef: PROJECT_REF,
        bootstrapComplete: true,
        projectExists: false,
      }),
    ).toBe("hub");
  });

  it("waits for bootstrap before deciding that a project is unknown", () => {
    expect(
      resolveProjectAvailabilityRedirect({
        routeRef: PROJECT_REF,
        bootstrapComplete: false,
        projectExists: false,
      }),
    ).toBeNull();
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
});
