import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import {
  isValidProjectRouteId,
  resolveProjectAvailabilityRedirect,
  resolveProjectContentRedirect,
  resolveProjectRouteRef,
} from "./projectRoutes";

const PROJECT_REF = scopeProjectRef("env-1" as never, "project-1" as never);

describe("projectRoutes", () => {
  it("parses a complete physical project ref from route params", () => {
    expect(resolveProjectRouteRef(PROJECT_REF)).toEqual(PROJECT_REF);
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
});
