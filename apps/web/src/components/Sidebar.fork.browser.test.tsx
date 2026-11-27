import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
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
vi.mock(import("../state/server"), async (original) => {
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+shift+]", command: "thread.next" },
    { key: "mod+shift+[", command: "thread.previous" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
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

async function renderSidebar() {
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
  const screen = await render(
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>
    </AppAtomRegistryProvider>,
    { router: "/mine/thread-mine" },
  );
  const card = (title: string) =>
    screen.getByTestId("sidebar-row-card").filter({ hasText: title }).first();
  return Object.assign(screen, { card });
}

it("names who shared a thread on its card, and leaves my own cards alone", async () => {
  await using screen = await renderSidebar();
  const { card } = screen;

  await expect.element(card("Alex's thread")).toHaveAccessibleDescription("Shared by Alex");
  await expect.element(card("Guest link thread")).toHaveAccessibleDescription("Shared with you");
  await expect.element(card("My thread")).not.toHaveAttribute("aria-describedby");
  await expect.element(card("My thread")).not.toHaveTextContent("Shared");
});

it("switches the sidebar to a colleague's inbox, showing only their threads, and back", async () => {
  await using screen = await renderSidebar();
  const { card } = screen;
  const inboxSwitch = screen.getByRole("combobox", { name: "Switch inbox" });

  await inboxSwitch.click();
  await screen.getByRole("option", { name: "Alex" }).click();
  const alexInbox = screen.getByRole("list", { name: "Alex's inbox" });
  await expect.element(alexInbox.getByRole("button", { name: /Alex's thread/ })).toBeVisible();
  await expect.element(alexInbox).not.toHaveTextContent("My thread");
  await expect.element(alexInbox).not.toHaveTextContent("Guest link thread");
  await expect.element(card("My thread")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("combobox", { name: "Search threads" }))
    .not.toBeInTheDocument();

  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await userEvent.keyboard("{Control>}{Shift>}]{/Shift}{/Control}");
  await userEvent.keyboard("{Control>}{Shift>}[[{/Shift}{/Control}");
  expect(screen.router?.state.location.pathname).toBe("/mine/thread-mine");

  await inboxSwitch.click();
  await screen.getByRole("option", { name: "My inbox" }).click();
  await expect.element(alexInbox).not.toBeInTheDocument();
  await expect.element(card("My thread")).toBeVisible();
  await expect.element(card("Alex's thread")).toHaveAccessibleDescription("Shared by Alex");
  await userEvent.keyboard("{Control>}{Shift>}[[{/Shift}{/Control}");
  expect(screen.router?.state.location.pathname).not.toBe("/mine/thread-mine");
});
