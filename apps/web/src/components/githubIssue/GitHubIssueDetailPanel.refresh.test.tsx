import type { EnvironmentId, GitHubIssueDetail, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitHubIssueDetailPanel } from "./GitHubIssueDetailPanel";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  data: null as GitHubIssueDetail | null,
  isPending: false,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.data,
    dataUpdatedAt: null,
    error: null,
    isPending: state.isPending,
    isSuccess: true,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/githubIssues", () => ({
  githubIssueEnvironment: { detail: () => ({}) },
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => undefined,
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => vi.fn(),
}));
vi.mock("../pullRequest/PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ text }: { readonly text: string }) => text,
}));

function makeDetail(): GitHubIssueDetail {
  return {
    projectId: "project-1",
    projectTitle: "web",
    repository: "acme/web",
    number: 42,
    title: "Fix the cache",
    url: "https://github.com/acme/web/issues/42",
    author: null,
    assignees: [],
    labels: [],
    state: "open",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    workspaceRoot: "/tmp/ws",
    body: "Fix it",
    comments: [],
    commentCount: 0,
    closedAt: null,
  } as unknown as GitHubIssueDetail;
}

function renderPanel(reference?: {
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
}) {
  const ref = reference ?? { projectId: "project-1", repository: "acme/web", number: 42 };
  const element = (
    <GitHubIssueDetailPanel
      environmentId={"env-1" as EnvironmentId}
      onSelectSubIssue={() => {}}
      reference={{
        projectId: ref.projectId as ProjectId,
        repository: ref.repository,
        number: ref.number,
      }}
    />
  );
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element);
  });
  if (!renderer) throw new Error("Panel did not render.");
  return renderer;
}

describe("GitHub issue side panel refresh", () => {
  beforeEach(() => {
    state.refresh.mockClear();
    state.data = makeDetail();
    state.isPending = false;
  });

  it("re-reads the open issue once when the panel opens, not on every render", () => {
    const renderer = renderPanel();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.update(
        <GitHubIssueDetailPanel
          environmentId={"env-1" as EnvironmentId}
          onSelectSubIssue={() => {}}
          reference={{
            projectId: "project-1" as ProjectId,
            repository: "acme/web",
            number: 42,
          }}
        />,
      );
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-reads once when a different issue opens under the mounted panel", () => {
    const renderer = renderPanel();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.update(
        <GitHubIssueDetailPanel
          environmentId={"env-1" as EnvironmentId}
          onSelectSubIssue={() => {}}
          reference={{
            projectId: "project-1" as ProjectId,
            repository: "acme/web",
            number: 43,
          }}
        />,
      );
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
    act(() => {
      renderer.update(
        <GitHubIssueDetailPanel
          environmentId={"env-1" as EnvironmentId}
          onSelectSubIssue={() => {}}
          reference={{
            projectId: "project-1" as ProjectId,
            repository: "acme/web",
            number: 43,
          }}
        />,
      );
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("re-reads on demand from the header refresh control", () => {
    const renderer = renderPanel();
    const button = renderer.root.findByProps({ "aria-label": "Refresh issue" });
    act(() => {
      button.props.onClick();
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });
});
