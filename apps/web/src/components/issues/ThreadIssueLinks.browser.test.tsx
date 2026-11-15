import type { EnvironmentId, ThreadId, ThreadIssueLink } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { ThreadIssueLinks } from "./ThreadIssueLinks";

// The thread shell as a store, so a sync lands in the mounted panel the way the real store does.
const shell = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let current = { issues: [] as ReadonlyArray<ThreadIssueLink> };
  return {
    get: () => current,
    set: (issues: ReadonlyArray<ThreadIssueLink>) => {
      current = { issues };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map([["env-1", { environment: { capabilities: { threadIssues: true } } }]])) as never,
  useThreadShell: (() => useSyncExternalStore(shell.subscribe, shell.get)) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn(async () => ({ _tag: "Success" }))) as never,
}));

const link = (number: number, snapshot: ThreadIssueLink["snapshot"]): ThreadIssueLink => ({
  host: "github.com",
  repository: "acme/web",
  number,
  url: `https://github.com/acme/web/issues/${number}`,
  source: "manual",
  linkedAt: "2026-11-01T00:00:00.000Z",
  snapshot,
});

const threadRef = { environmentId: "env-1" as EnvironmentId, threadId: "thread-1" as ThreadId };

describe("ThreadIssueLinks", () => {
  it("opens a parent whose snapshot arrives after mount, until the user collapses it", async () => {
    const child = link(2, {
      title: "Linked child",
      state: "open",
      syncedAt: "2026-11-01T00:00:00.000Z",
    });
    shell.set([link(1, null), child]);
    await using screen = await render(<ThreadIssueLinks threadRef={threadRef} />);
    await expect.element(screen.getByText("Linked child")).toBeVisible();

    await act(() =>
      shell.set([
        link(1, {
          title: "Parent",
          state: "open",
          subIssues: [{ number: 2, title: "Linked child", url: child.url, state: "open" }],
          syncedAt: "2026-11-01T00:01:00.000Z",
        }),
        child,
      ]),
    );
    await expect.element(screen.getByText("Parent")).toBeVisible();
    await expect.element(screen.getByText("Linked child")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Collapse sub-issues of #1" }));
    await expect.element(screen.getByText("Linked child")).not.toBeInTheDocument();
  });
});
