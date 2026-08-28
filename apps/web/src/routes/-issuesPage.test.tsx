import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    serverConfig: null | { environment: { capabilities: { githubIssues: boolean } } };
  }>,
  shellEnvironmentIds: [] as EnvironmentId[],
  listTargets: [] as Array<ReadonlyArray<{ environmentId: EnvironmentId; input: unknown }>>,
  projectMenuProps: null as null | {
    readonly value: string;
    readonly windowProjectKey: string | null;
    readonly onValueChange: (value: string) => void;
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));

vi.mock("../state/shell", () => ({
  allEnvironmentShellsBootstrappedAtom: { kind: "all" },
  environmentShellBootstrappedAtom: (environmentId: EnvironmentId) => {
    mocks.shellEnvironmentIds.push(environmentId);
    return { kind: "environment", environmentId };
  },
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));

vi.mock("../state/entities", () => ({
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
        displayName: "owner/one",
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
        displayName: "owner/two",
        canonicalKey: "github.com/owner/two",
      },
    },
  ],
}));

vi.mock("../state/githubIssues", () => ({
  githubIssueEnvironment: { detail: () => ({ kind: "detail" }) },
  useGitHubIssueList: (
    targets: ReadonlyArray<{ environmentId: EnvironmentId; input: unknown }>,
  ) => {
    mocks.listTargets.push(targets);
    return {
      data: { entries: [], errors: [], environmentErrors: [], truncated: false },
      isPending: false,
      refresh: () => undefined,
    };
  },
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));

vi.mock("../state/queries", () => ({ useDebouncedValue: (value: string) => value }));

vi.mock("../components/githubIssue/GitHubIssueDetailPanel", () => ({
  GitHubIssueDetailContent: () => "Issue detail",
}));
vi.mock("../components/githubIssue/GitHubIssueRow", () => ({ GitHubIssueRow: () => null }));
vi.mock("../components/githubIssue/GitHubIssueGhosts", () => ({
  GitHubIssueListGhosts: () => "Issue ghosts",
}));
vi.mock("../components/githubIssue/GitHubIssueEmptyState", () => ({
  GitHubIssueEmptyState: ({ title, description }: { title: string; description: string }) =>
    `${title}: ${description}`,
}));
vi.mock("../components/githubIssue/GitHubIssueProjectMenu", () => ({
  ALL_PROJECTS_VALUE: "__all__",
  GitHubIssueProjectMenu: (props: NonNullable<typeof mocks.projectMenuProps>) => {
    mocks.projectMenuProps = props;
    return `project menu: ${props.value}`;
  },
}));

import type { IssuesSearch } from "../components/githubIssue/githubIssueRouteSearch";
import { GitHubIssuesPage } from "./_chat.issues";

const environment1 = EnvironmentId.make("environment-1");
const environment2 = EnvironmentId.make("environment-2");
const projectKey = (environmentId: EnvironmentId, projectId: string) =>
  JSON.stringify([environmentId, projectId]);
const forcedProjectRef = scopeProjectRef(environment1, ProjectId.make("project-1"));
const baseSearch: IssuesSearch = { state: "open" };

function capable(environmentId: EnvironmentId, label: string) {
  return {
    environmentId,
    label,
    serverConfig: { environment: { capabilities: { githubIssues: true } } },
  };
}

describe("GitHubIssuesPage", () => {
  beforeEach(() => {
    mocks.environments = [capable(environment1, "One")];
    mocks.shellEnvironmentIds.length = 0;
    mocks.listTargets.length = 0;
    mocks.projectMenuProps = null;
  });

  it("defaults a project window to its own project and can still reach another", () => {
    mocks.environments = [capable(environment1, "One"), capable(environment2, "Two")];
    const navigations: Array<(previous: IssuesSearch) => IssuesSearch> = [];
    // A stale hub filter in the URL must not survive a window that is scoped to itself.
    const search: IssuesSearch = {
      ...baseSearch,
      projectId: ProjectId.make("project-2"),
      environmentId: environment2,
    };
    const html = renderToStaticMarkup(
      <GitHubIssuesPage
        forcedProjectRef={forcedProjectRef}
        search={search}
        onNavigate={(update) => navigations.push(update)}
      />,
    );

    expect(mocks.projectMenuProps?.windowProjectKey).toBe(projectKey(environment1, "project-1"));
    expect(mocks.projectMenuProps?.value).toBe(projectKey(environment1, "project-1"));
    expect(html).toContain("project menu");
    expect(mocks.listTargets.at(-1)).toEqual([
      {
        environmentId: environment1,
        input: expect.objectContaining({ projectId: "project-1" }),
      },
    ]);

    mocks.projectMenuProps?.onValueChange(projectKey(environment2, "project-2"));
    const next = navigations[0]?.(search);
    expect(next).toMatchObject({
      state: "open",
      scope: "all",
      projectId: "project-2",
      environmentId: environment2,
    });
  });

  it("returns a project window to itself, dropping the project filter", () => {
    mocks.environments = [capable(environment1, "One"), capable(environment2, "Two")];
    const navigations: Array<(previous: IssuesSearch) => IssuesSearch> = [];
    const search: IssuesSearch = {
      ...baseSearch,
      scope: "all",
      projectId: ProjectId.make("project-2"),
      environmentId: environment2,
    };
    renderToStaticMarkup(
      <GitHubIssuesPage
        forcedProjectRef={forcedProjectRef}
        search={search}
        onNavigate={(update) => navigations.push(update)}
      />,
    );

    expect(mocks.projectMenuProps?.value).toBe(projectKey(environment2, "project-2"));

    mocks.projectMenuProps?.onValueChange(projectKey(environment1, "project-1"));
    const next = navigations[0]?.(search);
    expect(next).toMatchObject({ state: "open" });
    expect(next).not.toHaveProperty("scope");
    expect(next).not.toHaveProperty("projectId");
    expect(next).not.toHaveProperty("environmentId");
  });

  it("does not let an offline second environment block the hub", () => {
    mocks.environments = [
      capable(environment1, "One"),
      { environmentId: EnvironmentId.make("environment-2"), label: "Two", serverConfig: null },
    ];
    const html = renderToStaticMarkup(
      <GitHubIssuesPage forcedProjectRef={null} search={baseSearch} onNavigate={() => undefined} />,
    );

    expect(html).not.toContain("Connecting to the environment");
    expect(mocks.listTargets.at(-1)?.map((target) => target.environmentId)).toEqual([environment1]);
  });

  it("renders the project-scoped list without page chrome in a right panel", () => {
    const html = renderToStaticMarkup(
      <GitHubIssuesPage
        forcedProjectRef={forcedProjectRef}
        search={baseSearch}
        onNavigate={() => undefined}
        variant="panel"
      />,
    );

    expect(html).toContain("project menu");
    expect(html).not.toContain('aria-label="Refresh GitHub issues"');
    expect(mocks.listTargets.at(-1)).toEqual([
      {
        environmentId: environment1,
        input: expect.objectContaining({ projectId: "project-1" }),
      },
    ]);
  });

  it("shows unavailable when a selected environment is missing from the catalog", () => {
    const html = renderToStaticMarkup(
      <GitHubIssuesPage
        forcedProjectRef={null}
        search={{
          state: "open",
          selectedEnvironmentId: EnvironmentId.make("missing-environment"),
          selectedProjectId: ProjectId.make("project-1"),
          repository: "owner/one",
          number: 42,
        }}
        onNavigate={() => undefined}
      />,
    );

    expect(html).toContain("This issue&#x27;s environment is no longer available");
    expect(html).not.toContain("Connecting to the environment");
  });
});
