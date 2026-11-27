import { createMemoryHistory } from "@tanstack/react-router";
import {
  IssueTrackerKind,
  RunId,
  WS_METHODS,
  type IssueRef,
  type IssueSummary,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import stylesheet from "~/index.css?inline";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  assistantItem,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it("a Linear chip shows its live title up front and keeps it past the hover card", async () => {
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  const thread = threadWithHistory("linear-chip", 1);
  const url = "https://linear.app/example/issue/WEB-125";
  const runId = RunId.make("linear-chip-run-0");
  using _environment = installFakeEnvironment([
    {
      ...thread,
      items: [
        thread.items[0]!,
        assistantItem(thread.id, runId, "linear-chip-answer", 1, `See [WEB-125](${url}).`),
      ],
    },
  ]);
  using _connections = answerRpc(WS_METHODS.issueTrackersList, () =>
    Effect.succeed({
      trackers: [],
      bindings: { [PROJECT_ID]: { tracker: IssueTrackerKind.make("linear"), scope: "WEB" } },
    }),
  );
  const liveTitle = "Add keyboard shortcuts to the sidebar";
  const reads: IssueRef[] = [];
  using _summary = answerRpc(WS_METHODS.issuesSummaryFork, (input: IssueRef) => {
    reads.push(input);
    return Effect.succeed({
      tracker: input.tracker,
      host: "linear.app",
      scope: input.scope,
      key: input.key,
      displayKey: "WEB-125",
      title: liveTitle,
      url,
      author: { login: "sam", name: null, avatarUrl: null },
      state: { category: "open", name: "Open" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      closedAt: null,
      assignees: [],
      labels: [],
      commentCount: 0,
    } satisfies IssueSummary);
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const titled = page.getByRole("link", { name: `WEB-125, ${liveTitle}`, exact: true });
  await expect.element(titled).toBeVisible();
  await userEvent.hover(titled);
  const card = page.getByText(liveTitle, { exact: true }).nth(1);
  await expect.element(card).toBeVisible();
  await userEvent.hover(page.getByText("linear-chip: question 0"));
  await expect.element(card).not.toBeInTheDocument();
  await expect.element(titled).toBeVisible();
  expect(reads).toHaveLength(1);
});
