import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  anchorSidebarGroupsFork,
  inheritedSidebarSnoozeOwnersFork,
  regroupSidebarSectionsFork,
} from "./Sidebar.groupSections.fork";
import { planSidebarThreadDrop as planGroupedSidebarThreadDropFork } from "./Sidebar.logic";

const environmentId = EnvironmentId.make("env");
const thread = (id: string) => ({ environmentId, id: ThreadId.make(id) });
const [parent, child, other] = [thread("p"), thread("c"), thread("o")];
const group = {
  id: "env:g",
  title: "G",
  threadIds: ["env:p", "env:c"],
  parentThreadId: "env:p",
  collapsed: false,
};
const ids = (threads: readonly { readonly id: string }[]) => threads.map((t) => t.id);

describe("regroupSidebarSectionsFork", () => {
  it("moves a group with its working parent, and keeps a working child home", () => {
    const active = [child, other];
    const working = [parent];
    regroupSidebarSectionsFork(active, working, [group], [], true);
    expect([ids(active), ids(working)]).toEqual([["o"], ["c", "p"]]);

    const home = [parent, other];
    const shelf = [child];
    regroupSidebarSectionsFork(home, shelf, [group], [], true);
    expect([ids(home), ids(shelf)]).toEqual([["p", "o", "c"], []]);
  });

  it("moves every inbox member to Pinned with its parent", () => {
    const sibling = thread("s");
    const withSibling = { ...group, threadIds: [...group.threadIds, "env:s"] };
    const active = [child, other];
    const working = [sibling];
    const pinned = [parent];

    regroupSidebarSectionsFork(active, working, [withSibling], pinned, true);
    expect([ids(pinned), ids(active), ids(working)]).toEqual([["p", "c", "s"], ["o"], []]);
  });

  it("keeps a single unpinned child with its pinned parent", () => {
    const active = [child];
    const working: typeof active = [];
    const pinned = [parent];
    regroupSidebarSectionsFork(active, working, [group], pinned, true);
    expect([ids(pinned), ids(active), ids(working)]).toEqual([["p", "c"], [], []]);
  });

  it("carries the group when Working is disabled, without changing other groups", () => {
    const active = [child, other];
    const working: typeof active = [];
    const pinned = [parent];
    regroupSidebarSectionsFork(active, working, [group], pinned, false);
    expect([ids(pinned), ids(active), ids(working)]).toEqual([["p", "c"], ["o"], []]);
  });

  it("keeps independent child pins when an unpinned parent carries its inbox members", () => {
    const sibling = thread("s");
    const active = [sibling, other];
    const working = [parent];
    const pinned = [child];
    regroupSidebarSectionsFork(
      active,
      working,
      [{ ...group, threadIds: [...group.threadIds, "env:s"] }],
      pinned,
      true,
    );
    expect([ids(pinned), ids(active), ids(working)]).toEqual([["c"], ["o"], ["s", "p"]]);
  });

  it("anchors a pinned group at its parent's rank", () => {
    expect(
      ids(anchorSidebarGroupsFork([child, other, parent], [group], (t) => `env:${t.id}`)),
    ).toEqual(["o", "c", "p"]);
  });

  it("snoozes working and independently pinned children with their parent", () => {
    const sibling = thread("s");
    const active = [other];
    const working = [child];
    const pinned = [sibling];
    const snoozed = [parent];
    regroupSidebarSectionsFork(
      active,
      working,
      [{ ...group, threadIds: [...group.threadIds, "env:s"] }],
      pinned,
      true,
      { snoozed, canInheritSnooze: () => true },
    );
    expect([ids(active), ids(working), ids(pinned), ids(snoozed)]).toEqual([
      ["o"],
      [],
      [],
      ["p", "c", "s"],
    ]);
  });

  it("leaves a child needing attention visible when its parent is snoozed", () => {
    const active = [child, other];
    const working: typeof active = [];
    const snoozed = [parent];
    regroupSidebarSectionsFork(active, working, [group], [], true, {
      snoozed,
      canInheritSnooze: (t) => t !== child,
    });
    expect([ids(active), ids(snoozed)]).toEqual([["c", "o"], ["p"]]);
  });

  it("wakes inherited snoozes through the parent but preserves independent timers", () => {
    const sibling = thread("s");
    const groups = [{ ...group, threadIds: [...group.threadIds, "env:s", "env:o"] }];
    const owners = inheritedSidebarSnoozeOwnersFork(
      [parent, child, sibling],
      groups,
      (t) => t !== child,
    );
    expect([...owners]).toEqual([["env:c", parent]]);
    expect(
      inheritedSidebarSnoozeOwnersFork([child, sibling], groups, (t) => t === sibling).size,
    ).toBe(0);
  });
});

describe("planGroupedSidebarThreadDropFork", () => {
  const input = {
    activeKey: "p",
    activeSection: "pinned" as const,
    activePinned: true,
    pinnedOrder: ["p", "o"],
    pinnedKeysById: new Map([
      ["p", "a0"],
      ["o", "a1"],
    ]),
    activeOrder: [],
    activeKeysById: new Map<string, string>(),
    target: { section: "pinned" as const, pinnedOrder: ["o", "p", "c"], activeOrder: [] },
  };

  it("reorders the parent without writing an inherited child's pin order", () => {
    const plan = planGroupedSidebarThreadDropFork(input);
    expect(plan).toMatchObject({ kind: "reorder-pinned", order: ["o", "p"] });
    if (plan.kind === "reorder-pinned")
      expect(plan.assignments.map(({ id }) => id)).not.toContain("c");
  });

  it("does not turn a child's inherited position into an independent pin", () => {
    expect(
      planGroupedSidebarThreadDropFork({
        ...input,
        activeKey: "c",
        activePinned: false,
        keepInheritedPin: true,
      }),
    ).toEqual({ kind: "none" });
  });

  it("pins a child independently when it leaves the group for a plain pinned slot", () => {
    expect(
      planGroupedSidebarThreadDropFork({ ...input, activeKey: "c", activePinned: false }),
    ).toMatchObject({ kind: "pin", order: ["o", "p", "c"] });
  });
});
