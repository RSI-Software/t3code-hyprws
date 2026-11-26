import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("mine"),
}));
vi.mock(import("./collaborator/colleagues.fork"), async (original) => ({
  ...(await original()),
  colleaguesServedFork: () => true,
  colleaguesAtom: () =>
    Atom.make(
      AsyncResult.success([
        {
          subject: "colleague:alex",
          name: "Alex",
          environmentId: EnvironmentId.make("alex"),
          url: "http://alex.invalid",
          savedAt: "2026-01-01T00:00:00.000Z",
          threadIds: [],
        },
      ]),
    ),
}));

function project(environmentId: string): Project {
  return {
    id: ProjectId.make(`project-${environmentId}`),
    environmentId: EnvironmentId.make(environmentId),
    title: `project-${environmentId}`,
    workspaceRoot: `/projects/${environmentId}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

it("names who shared a thread on its card, and leaves my own cards alone", async () => {
  const projects = ["mine", "alex", "guest"].map(project);
  const thread = (environmentId: string, title: string, collaboratorFork?: "send") =>
    makeThreadFixture({
      environmentId: EnvironmentId.make(environmentId),
      projectId: ProjectId.make(`project-${environmentId}`),
      id: ThreadId.make(`thread-${environmentId}`),
      title,
      ...(collaboratorFork && { collaboratorFork }),
    });
  const threads = [
    thread("mine", "My thread"),
    thread("alex", "Alex's thread", "send"),
    thread("guest", "Guest link thread", "send"),
  ];
  const routeThreadRef = { environmentId: threads[0]!.environmentId, threadId: threads[0]!.id };
  vi.mocked(useProjects).mockReturnValue(projects);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId: projects[0]!.environmentId, projectId: projects[0]!.id },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef,
  });
  await using screen = await render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
    { router: "/mine/thread-mine" },
  );
  const card = (title: string) =>
    screen.getByTestId("sidebar-row-card").filter({ hasText: title }).first();

  await expect.element(card("Alex's thread")).toHaveAccessibleDescription("Shared by Alex");
  await expect.element(card("Guest link thread")).toHaveAccessibleDescription("Shared with you");
  await expect.element(card("My thread")).not.toHaveAttribute("aria-describedby");
  await expect.element(card("My thread")).not.toHaveTextContent("Shared");
});
