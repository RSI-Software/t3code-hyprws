import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { publishedWindowScope, windowProjectScope } from "./windowProjects.fork";

const local = EnvironmentId.make("environment:local");
const remote = EnvironmentId.make("environment:remote");
const web = ProjectId.make("project:web");
const api = ProjectId.make("project:api");

const project = (environmentId: EnvironmentId, id: ProjectId, workspaceRoot: string) =>
  ({ environmentId, id, workspaceRoot }) as unknown as EnvironmentProject;

const projects = [
  project(local, web, "/home/me/src/web"),
  project(local, api, "/home/me/src/api"),
  project(remote, web, "/srv/web"),
];

describe("windowProjectScope", () => {
  it("reports only nonexcluded checkouts, including projects added later", () => {
    const filter = {
      mode: "exclude" as const,
      entries: [
        {
          key: "web",
          members: [
            { environmentId: local, projectId: web },
            { environmentId: remote, projectId: web },
          ],
        },
      ],
    };
    expect(windowProjectScope(filter, projects)).toEqual({
      kind: "projects",
      projects: [{ environmentId: local, projectId: api, workspaceRoot: "/home/me/src/api" }],
    });
    const newProject = project(remote, api, "/srv/api");
    expect(windowProjectScope(filter, [...projects, newProject])).toEqual({
      kind: "projects",
      projects: [
        { environmentId: local, projectId: api, workspaceRoot: "/home/me/src/api" },
        { environmentId: remote, projectId: api, workspaceRoot: "/srv/api" },
      ],
    });
  });

  it("reports every project for an empty filter", () => {
    expect(windowProjectScope({ entries: [] }, projects)).toEqual({ kind: "all" });
  });

  it("reports each member with its environment's checkout", () => {
    const scope = windowProjectScope(
      {
        entries: [
          {
            key: "github.com/acme/web",
            members: [
              { environmentId: local, projectId: web },
              { environmentId: remote, projectId: web },
            ],
          },
        ],
      },
      projects,
    );
    expect(scope).toEqual({
      kind: "projects",
      projects: [
        { environmentId: local, projectId: web, workspaceRoot: "/home/me/src/web" },
        { environmentId: remote, projectId: web, workspaceRoot: "/srv/web" },
      ],
    });
  });

  it("leaves out members with no known checkout and repeats", () => {
    const member = { environmentId: local, projectId: api };
    const scope = windowProjectScope(
      {
        entries: [
          { key: "api", members: [member, member] },
          {
            key: "offline",
            members: [{ environmentId: remote, projectId: ProjectId.make("project:gone") }],
          },
        ],
      },
      projects,
    );
    expect(scope).toEqual({
      kind: "projects",
      projects: [{ environmentId: local, projectId: api, workspaceRoot: "/home/me/src/api" }],
    });
  });
});

describe("publishedWindowScope", () => {
  it("publishes visible projects even when an excluded environment is offline", () => {
    expect(
      publishedWindowScope({
        filter: {
          mode: "exclude",
          entries: [{ key: "offline", members: [{ environmentId: remote, projectId: web }] }],
        },
        pendingSeed: null,
        settled: false,
        projects: [projects[0]!, projects[1]!],
      }),
    ).toEqual({
      kind: "projects",
      projects: [
        { environmentId: local, projectId: web, workspaceRoot: "/home/me/src/web" },
        { environmentId: local, projectId: api, workspaceRoot: "/home/me/src/api" },
      ],
    });
  });

  const apiOnly = {
    entries: [{ key: "api", members: [{ environmentId: local, projectId: api }] }],
  };

  it("holds a member whose checkout is unknown until every environment settles", () => {
    const loading = projects.filter((candidate) => candidate.id !== api);
    expect(
      publishedWindowScope({
        filter: apiOnly,
        pendingSeed: null,
        settled: false,
        projects: loading,
      }),
    ).toBeNull();
  });

  it("publishes known members while another environment is unreachable", () => {
    expect(
      publishedWindowScope({ filter: apiOnly, pendingSeed: null, settled: false, projects }),
    ).toEqual({
      kind: "projects",
      projects: [{ environmentId: local, projectId: api, workspaceRoot: "/home/me/src/api" }],
    });
  });

  it("publishes an all-projects window before environments settle", () => {
    expect(
      publishedWindowScope({
        filter: { entries: [] },
        pendingSeed: null,
        settled: false,
        projects: [],
      }),
    ).toEqual({ kind: "all" });
  });

  it("publishes the window's own filter once settled", () => {
    expect(
      publishedWindowScope({ filter: apiOnly, pendingSeed: null, settled: true, projects }),
    ).toEqual({
      kind: "projects",
      projects: [{ environmentId: local, projectId: api, workspaceRoot: "/home/me/src/api" }],
    });
  });

  it("publishes a pending seed project over the unseeded filter", () => {
    expect(
      publishedWindowScope({
        filter: { entries: [] },
        pendingSeed: { environmentId: remote, projectId: web },
        settled: true,
        projects,
      }),
    ).toEqual({
      kind: "projects",
      projects: [{ environmentId: remote, projectId: web, workspaceRoot: "/srv/web" }],
    });
  });
});
