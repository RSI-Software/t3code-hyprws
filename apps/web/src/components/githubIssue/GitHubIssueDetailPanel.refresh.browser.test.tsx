import type { EnvironmentId, GitHubIssueDetail, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { GitHubIssueDetailPanel } from "./GitHubIssueDetailPanel";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  data: null as GitHubIssueDetail | null,
  isPending: false,
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.data,
    dataUpdatedAt: null,
    error: null,
    isPending: state.isPending,
    isSuccess: true,
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => undefined) as never,
}));
vi.mock(import("../../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => vi.fn()) as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() => new Map()) as never,
}));
vi.mock(import("../pullRequest/PullRequestMarkdown"), async (original) => ({
  ...(await original()),
  PullRequestMarkdown: (({ text }: { readonly text: string }) => text) as never,
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

function panel(number = 42) {
  return (
    <GitHubIssueDetailPanel
      environmentId={"env-1" as EnvironmentId}
      composerTarget={null}
      onSelectSubIssue={() => {}}
      reference={{ projectId: "project-1" as ProjectId, repository: "acme/web", number }}
    />
  );
}

function renderPanel() {
  state.refresh.mockClear();
  state.data = makeDetail();
  state.isPending = false;
  return render(panel(), { router: false });
}

describe("GitHub issue side panel refresh", () => {
  it("re-reads the open issue once when the panel opens, not on every render", async () => {
    await using screen = await renderPanel();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await screen.rerender(panel());
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-reads once when a different issue opens under the mounted panel", async () => {
    await using screen = await renderPanel();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await screen.rerender(panel(43));
    expect(state.refresh).toHaveBeenCalledTimes(2);
    await screen.rerender(panel(43));
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("re-reads on demand from the actions menu", async () => {
    await using _screen = await renderPanel();
    await page.getByRole("button", { name: "More issue actions" }).click();
    await page.getByRole("menuitem", { name: "Refresh" }).click();
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });
});
