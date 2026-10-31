import type { DragOverEvent } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";
import { buildSidebarListItems, sidebarListItemId, sidebarMarkerId } from "./Sidebar.logic";
import { useSidebarThreadGroupDragFork } from "./SidebarThreadGroup.drag";
import { sidebarThreadGroupHeaderMarker } from "./SidebarThreadGroup.markers";

function press(screen: Screen, name: string) {
  // Keep button automation from moving the pointer during a drag.
  return act(() =>
    screen
      .getByRole("button", { name })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

const states = [
  { source: "active", parent: "active" },
  { source: "working", parent: "active" },
  { source: "active", parent: "working" },
  { source: "working", parent: "working" },
] as const;

function fixture(
  source: "active" | "working",
  parent: "active" | "working",
  grouped: boolean,
  collapsed = false,
) {
  const group = {
    id: "env:group",
    title: "Group",
    threadIds: ["env:parent", "env:child"],
    parentThreadId: "env:parent",
    collapsed,
  };
  const spans = grouped
    ? [
        {
          groupKey: group.id,
          group,
          threads: [],
          visibleKeys: collapsed ? [group.parentThreadId] : group.threadIds,
          parentKey: group.parentThreadId,
        },
      ]
    : [];
  const rows = [
    { key: "env:source", section: source },
    { key: "env:parent", section: parent },
    ...(grouped && !collapsed ? [{ key: "env:child", section: parent }] : []),
  ];
  const items = buildSidebarListItems({
    hasNoThreads: false,
    pinnedKeys: [],
    activeKeys: rows.filter((row) => row.section === "active").map((row) => row.key),
    workingKeys: rows.filter((row) => row.section === "working").map((row) => row.key),
    hasSnoozedThreads: false,
    snoozedVisibleKeys: [],
    settledKeys: [],
    activeGroups: spans,
  });
  const sourceIndex = items.findIndex((item) => sidebarListItemId(item) === "env:source");
  const parentIndex = items.findIndex((item) => sidebarListItemId(item) === "env:parent");
  const overId = sidebarListItemId(items[parentIndex + (sourceIndex < parentIndex ? 0 : 1)]!);
  return { items, spans, overId };
}

function DragHost(props: {
  readonly data: ReturnType<typeof fixture>;
  readonly setMembership: Parameters<
    typeof useSidebarThreadGroupDragFork<string>
  >[0]["setMembership"];
  readonly requestTitle: Parameters<
    typeof useSidebarThreadGroupDragFork<string>
  >[0]["requestTitle"];
  readonly permitted?: boolean;
  readonly offset?: number;
}) {
  const { data } = props;
  const drag = useSidebarThreadGroupDragFork({
    ...data,
    threadByKey: new Map(["source", "parent", "child"].map((id) => [`env:${id}`, id])),
    setMembership: props.setMembership,
    requestTitle: props.requestTitle,
    canGroup: () => props.permitted !== false,
  });
  const event = {
    active: { id: "env:source" },
    over: { id: data.overId },
    activatorEvent: new PointerEvent("pointerdown", { clientX: 100 }),
  } as unknown as DragOverEvent;
  return (
    <>
      <button onClick={() => drag.over(event)}>Lift</button>
      <button
        onClick={() =>
          document.dispatchEvent(
            new PointerEvent("pointermove", { clientX: 100 + (props.offset ?? 15) }),
          )
        }
      >
        Nest
      </button>
      <button onClick={() => drag.release(event)}>Release</button>
      <button onClick={drag.dndHandlers.onDragCancel}>Cancel</button>
      <output>{drag.projection?.parent?.kind ?? "none"}</output>
    </>
  );
}

describe.each(states)("$source thread under $parent parent", ({ source, parent }) => {
  it.each([
    { grouped: false, collapsed: false },
    { grouped: true, collapsed: false },
    { grouped: true, collapsed: true },
  ])(
    "persists membership (grouped: $grouped, collapsed: $collapsed)",
    async ({ grouped, collapsed }) => {
      const setMembership = vi.fn(() => true);
      const requestTitle = vi.fn();
      await using screen = await render(
        <DragHost
          data={fixture(source, parent, grouped, collapsed)}
          setMembership={setMembership}
          requestTitle={requestTitle}
        />,
      );
      await press(screen, "Lift");
      await press(screen, "Nest");
      await expect
        .element(screen.getByRole("status"))
        .toHaveTextContent(grouped ? "group" : "thread");
      await press(screen, "Release");
      expect(setMembership).toHaveBeenCalledExactlyOnceWith(
        grouped ? ["env:source"] : ["env:parent", "env:source"],
        grouped
          ? { kind: "existing", groupId: "env:group" }
          : { kind: "new", group: expect.objectContaining({ title: "New group" }) },
      );
      expect(requestTitle).toHaveBeenCalledTimes(grouped ? 0 : 1);
    },
  );
});

it.each(["cancel", "denied"])("does not write a %s Working group drop", async (reason) => {
  const setMembership = vi.fn(() => true);
  await using screen = await render(
    <DragHost
      data={fixture("active", "working", false)}
      setMembership={setMembership}
      requestTitle={vi.fn()}
      permitted={reason !== "denied"}
    />,
  );
  await press(screen, "Lift");
  await press(screen, "Nest");
  if (reason === "cancel") await press(screen, "Cancel");
  await press(screen, "Release");
  expect(setMembership).not.toHaveBeenCalled();
});

it("makes an idle thread the parent when dropped flush below a collapsed Working group's tab", async () => {
  const setMembership = vi.fn(() => true);
  const data = {
    ...fixture("active", "working", true, true),
    overId: sidebarMarkerId(sidebarThreadGroupHeaderMarker("env:group")),
  };
  await using screen = await render(
    <DragHost data={data} setMembership={setMembership} requestTitle={vi.fn()} offset={0} />,
  );
  await press(screen, "Lift");
  await press(screen, "Release");
  expect(setMembership).toHaveBeenCalledExactlyOnceWith(["env:source"], {
    kind: "existing",
    groupId: "env:group",
    asParent: true,
  });
});

it("lets a Working child leave its group by dragging left", async () => {
  const setMembership = vi.fn(() => true);
  const span = fixture("working", "working", true).spans[0]!;
  const threadIds = ["env:parent", "env:source"];
  const spans = [{ ...span, group: { ...span.group, threadIds }, visibleKeys: threadIds }];
  const data = {
    items: buildSidebarListItems({
      hasNoThreads: false,
      pinnedKeys: [],
      activeKeys: [],
      workingKeys: ["env:parent", "env:source", "env:child"],
      hasSnoozedThreads: false,
      snoozedVisibleKeys: [],
      settledKeys: [],
      activeGroups: spans,
    }),
    spans,
    overId: "env:source",
  };
  await using screen = await render(
    <DragHost data={data} setMembership={setMembership} requestTitle={vi.fn()} offset={-15} />,
  );
  await press(screen, "Lift");
  await press(screen, "Nest");
  await press(screen, "Release");
  expect(setMembership).toHaveBeenCalledExactlyOnceWith(["env:source"], { kind: "none" });
});
