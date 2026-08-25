import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  filterProps: null as null | {
    readonly projects: ReadonlyArray<unknown> | null;
    readonly serverOptions: ReadonlyArray<unknown>;
  },
  listTargets: [] as Array<
    ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId?: ProjectId };
    }>
  >,
  scopeToggleProps: null as null | {
    readonly listScope:
      | { readonly kind: "all" }
      | { readonly kind: "project"; readonly projectRef: unknown };
    readonly onNavigate: (scope: "all" | undefined) => void;
  },
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment-1",
        label: "One",
        displayUrl: null,
        serverConfig: { environment: { capabilities: { pullRequests: true } } },
      },
      {
        environmentId: "environment-2",
        label: "Two",
        displayUrl: "https://two.example.com",
        serverConfig: { environment: { capabilities: { pullRequests: true } } },
      },
    ],
  }),
}));

vi.mock("../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => true,
  useProjects: () => [
    {
      id: "project-1",
      environmentId: "environment-1",
      title: "Project One",
      workspaceRoot: "/workspace/one",
      repositoryIdentity: {
        provider: "github",
        owner: "owner",
        name: "one",
        canonicalKey: "github.com/owner/one",
      },
    },
    {
      id: "project-2",
      environmentId: "environment-2",
      title: "Project Two",
      workspaceRoot: "/workspace/two",
      repositoryIdentity: {
        provider: "github",
        owner: "owner",
        name: "two",
        canonicalKey: "github.com/owner/two",
      },
    },
  ],
}));

vi.mock("../state/pullRequests", () => {
  const emptyData = {
    viewers: {},
    providers: [],
    entries: [],
    errors: [],
    truncated: false,
    nextCursors: {},
    truncatedEnvironments: [],
  };
  return {
    pullRequestEnvironment: { invalidate: { label: "pull-request-invalidate" } },
    usePullRequestList: (
      targets: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly input: { readonly projectId?: ProjectId };
      }>,
    ) => {
      mocks.listTargets.push(targets);
      return {
        data: emptyData,
        error: null,
        isPending: false,
        refresh: () => undefined,
      };
    },
    usePullRequestListStats: () => ({ stats: null, refresh: () => undefined }),
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));

vi.mock("../components/pullRequest/PullRequestListFilters", async () => {
  const actual = await vi.importActual<
    typeof import("../components/pullRequest/PullRequestListFilters")
  >("../components/pullRequest/PullRequestListFilters");
  return {
    ...actual,
    PullRequestFiltersMenu: (props: NonNullable<typeof mocks.filterProps>) => {
      mocks.filterProps = props;
      return props.projects === null ? "Filters without project picker" : "Project picker";
    },
    PullRequestSearchInput: () => null,
  };
});

vi.mock("../components/WindowProjectScopeToggle", () => ({
  WindowProjectScopeToggle: (props: NonNullable<typeof mocks.scopeToggleProps>) => {
    mocks.scopeToggleProps = props;
    return "This project";
  },
}));

import type { PullRequestsSearch } from "../components/pullRequest/pullRequestListRoute";
import { PullRequestsPage } from "./_chat.pull-requests";

const forcedProjectRef = scopeProjectRef(
  "environment-1" as EnvironmentId,
  "project-1" as ProjectId,
);

const search: PullRequestsSearch = {
  involvement: "all",
  state: "open",
  projectId: "hub-project" as ProjectId,
  selectedEnvironmentId: "environment-2" as EnvironmentId,
  selectedProjectId: "project-2" as ProjectId,
  repository: "owner/two",
  number: 42,
};

describe("PullRequestsPage project route", () => {
  beforeEach(() => {
    mocks.filterProps = null;
    mocks.listTargets.length = 0;
    mocks.scopeToggleProps = null;
  });

  it("forces route identity, hides hub pickers, and cleans hub search state on navigation", () => {
    const navigations: Array<(previous: PullRequestsSearch) => PullRequestsSearch> = [];
    const html = renderToStaticMarkup(
      <PullRequestsPage
        forcedProjectRef={forcedProjectRef}
        search={search}
        onNavigate={(update) => navigations.push(update)}
      />,
    );

    expect(html).toContain("Filters without project picker");
    expect(html).not.toContain("Project picker");
    expect(mocks.filterProps?.projects).toBeNull();
    expect(mocks.filterProps?.serverOptions).toEqual([]);
    expect(mocks.scopeToggleProps?.listScope).toEqual({
      kind: "project",
      projectRef: forcedProjectRef,
    });

    const nonEmptyTargets = mocks.listTargets.flatMap((targets) =>
      targets.length === 0 ? [] : [targets],
    );
    expect(nonEmptyTargets.length).toBeGreaterThan(0);
    for (const targets of nonEmptyTargets) {
      expect(targets).toEqual(
        targets.map(() => ({
          environmentId: "environment-1",
          input: expect.objectContaining({ projectId: "project-1" }),
        })),
      );
    }

    mocks.scopeToggleProps?.onNavigate("all");
    expect(navigations).toHaveLength(1);
    const next = navigations[0]?.(search);
    expect(next).not.toHaveProperty("projectId");
    expect(next).not.toHaveProperty("selectedEnvironmentId");
    expect(next).not.toHaveProperty("selectedProjectId");
    expect(next).not.toHaveProperty("repository");
    expect(next).not.toHaveProperty("number");
    expect(next).toMatchObject({ involvement: "all", state: "open", scope: "all" });
  });

  it("restores all-project scope from the URL on reload", () => {
    renderToStaticMarkup(
      <PullRequestsPage
        forcedProjectRef={forcedProjectRef}
        search={{ ...search, scope: "all" }}
        onNavigate={() => undefined}
      />,
    );

    expect(mocks.scopeToggleProps?.listScope).toEqual({ kind: "all" });
    const targets = mocks.listTargets.find((candidate) => candidate.length > 0);
    expect(targets).toEqual([
      { environmentId: "environment-1", input: expect.not.objectContaining({ projectId: "" }) },
      { environmentId: "environment-2", input: expect.not.objectContaining({ projectId: "" }) },
    ]);
    expect(targets?.every((target) => target.input.projectId === undefined)).toBe(true);
  });
});
