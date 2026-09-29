import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    serverConfig: null | { environment: { capabilities: { githubIssues: boolean } } };
  }>,
  listTargets: [] as Array<ReadonlyArray<{ environmentId: EnvironmentId; input: unknown }>>,
  projectMenuProps: null as null | {
    readonly value: string;
    readonly onValueChange: (value: string) => void;
  },
  windowProjectKeys: null as ReadonlySet<string> | null,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));

vi.mock("../state/shell", () => ({
  allEnvironmentShellsBootstrappedAtom: { kind: "all" },
}));

vi.mock("../windowProjectFilter.fork", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../windowProjectFilter.fork")>()),
  useWindowProjectKeys: () => mocks.windowProjectKeys,
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
    mocks.listTargets.length = 0;
    mocks.projectMenuProps = null;
    mocks.windowProjectKeys = null;
  });

  it("lists all projects as the projects in this window's filter", () => {
    mocks.environments = [capable(environment1, "One"), capable(environment2, "Two")];
    mocks.windowProjectKeys = new Set([
      scopedProjectKey(scopeProjectRef(environment2, ProjectId.make("project-2"))),
    ]);
    renderToStaticMarkup(<GitHubIssuesPage search={baseSearch} onNavigate={() => undefined} />);

    expect(mocks.projectMenuProps?.value).toBe("__all__");
    expect(mocks.listTargets.at(-1)).toEqual([
      {
        environmentId: environment2,
        input: expect.objectContaining({ projectId: "project-2" }),
      },
    ]);
  });

  it("filters to a picked project with a plain project filter", () => {
    mocks.environments = [capable(environment1, "One"), capable(environment2, "Two")];
    const navigations: Array<(previous: IssuesSearch) => IssuesSearch> = [];
    renderToStaticMarkup(
      <GitHubIssuesPage search={baseSearch} onNavigate={(update) => navigations.push(update)} />,
    );

    mocks.projectMenuProps?.onValueChange(projectKey(environment2, "project-2"));
    expect(navigations[0]?.(baseSearch)).toStrictEqual({
      state: "open",
      projectId: "project-2",
      environmentId: environment2,
    });
  });

  it("does not let an offline second environment block the hub", () => {
    mocks.environments = [
      capable(environment1, "One"),
      { environmentId: EnvironmentId.make("environment-2"), label: "Two", serverConfig: null },
    ];
    const html = renderToStaticMarkup(
      <GitHubIssuesPage search={baseSearch} onNavigate={() => undefined} />,
    );

    expect(html).not.toContain("Connecting to the environment");
    expect(mocks.listTargets.at(-1)?.map((target) => target.environmentId)).toEqual([environment1]);
  });

  it("renders the project-scoped list without page chrome in a right panel", () => {
    const html = renderToStaticMarkup(
      <GitHubIssuesPage
        search={{
          ...baseSearch,
          projectId: ProjectId.make("project-1"),
          environmentId: environment1,
        }}
        onNavigate={() => undefined}
        variant="panel"
      />,
    );

    expect(html).toContain("project menu");
    expect(html).not.toContain('aria-label="GitHub issues breadcrumb"');
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
