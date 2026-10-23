import { describe, expect, it } from "vite-plus/test";

import { createSidebarCollisionDetection, createSidebarSortingStrategy } from "./Sidebar.drag.ts";
import {
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarSection,
} from "./Sidebar.logic.ts";
import { sidebarThreadGroupHeaderMarker } from "./SidebarThreadGroup.markers.ts";

const thread = (key: string, section: SidebarSection): SidebarListItem => ({
  kind: "thread",
  key,
  section,
});

const rect = (top: number, height: number) => ({
  top,
  height,
  bottom: top + height,
  left: 0,
  right: 260,
  width: 260,
});

const HEADER_MARKER = sidebarThreadGroupHeaderMarker("group");
const HEADER_ID = sidebarMarkerId(HEADER_MARKER);

/** The divider row renders whether or not Pins holds anything, and its label
    spans the sidebar, so the section branch runs at every ordinary pointer x. */
function collisionArgs(pointerX: number) {
  const items: readonly SidebarListItem[] = [
    { kind: "marker", marker: "pinned-header" },
    thread("pinned", "pinned"),
    { kind: "marker", marker: "pinned-divider" },
    thread("member", "active"),
    thread("source", "active"),
    { kind: "marker", marker: HEADER_MARKER },
    { kind: "marker", marker: "settled-header" },
  ];
  // The header sits nearest the lifted card; the member row is far above it.
  const rects = new Map<string, ReturnType<typeof rect>>([
    [sidebarMarkerId("pinned-header"), rect(100, 0)],
    ["pinned", rect(110, 82)],
    [sidebarMarkerId("pinned-divider"), rect(200, 0)],
    ["member", rect(300, 82)],
    ["source", rect(400, 82)],
    [HEADER_ID, rect(445, 32)],
    [sidebarMarkerId("settled-header"), rect(600, 32)],
  ]);
  const boundaryNode = {
    querySelector: () => ({
      getBoundingClientRect: () => ({ top: 200, bottom: 216, left: 0, right: 260 }),
    }),
  } as unknown as HTMLElement;
  const settledNode = {
    getBoundingClientRect: () => ({ top: 600 }),
  } as unknown as HTMLElement;
  const collisionRect = rect(420, 82);
  const containers = [...rects.keys()].map((id) => ({
    id,
    key: id,
    disabled: false,
    data: { current: {} },
    node: {
      current:
        id === sidebarMarkerId("pinned-divider")
          ? boundaryNode
          : id === sidebarMarkerId("settled-header")
            ? settledNode
            : null,
    },
    rect: { current: rects.get(id)! },
  }));
  return {
    items,
    args: {
      active: {
        id: "source",
        data: { current: {} },
        rect: { current: { initial: collisionRect, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates: { x: pointerX, y: collisionRect.top + collisionRect.height / 2 },
    } as unknown as Parameters<ReturnType<typeof createSidebarCollisionDetection>>[0],
  };
}

describe("createSidebarCollisionDetection group headers", () => {
  it.each([130, 244])("keeps the nearest group header first at pointer x %i", (pointerX) => {
    const { items, args } = collisionArgs(pointerX);
    const detector = createSidebarCollisionDetection(() => true, {
      items,
      activationY: 441,
    });
    expect(detector(args)[0]?.id).toBe(HEADER_ID);
  });

  it("still promotes an active row when no header is nearer", () => {
    const { items, args } = collisionArgs(130);
    const detector = createSidebarCollisionDetection(() => true, {
      items,
      activationY: 441,
    });
    const withoutHeader = {
      ...args,
      // Without the header the lifted card itself is nearest, so drop both.
      droppableContainers: args.droppableContainers.filter(
        (container) => container.id !== HEADER_ID && container.id !== "source",
      ),
    };
    expect(detector(withoutHeader)[0]?.id).toBe("member");
  });
});

describe("createSidebarSortingStrategy folded group parent", () => {
  it("opens a gap the height of a taller lifted card", () => {
    // A collapsed group's parent carries its fold strip, so it outgrows a card.
    const items: SidebarListItem[] = [
      { kind: "marker", marker: "pinned-header" },
      { kind: "marker", marker: "pinned-divider" },
      thread("above", "active"),
      thread("parent", "active"),
      { kind: "marker", marker: "settled-header" },
      { kind: "marker", marker: "settled-placeholder" },
    ];
    const rects = [
      rect(100, 0),
      rect(101, 0),
      rect(102, 82),
      rect(185, 110),
      rect(296, 32),
      rect(329, 0),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: false,
    });
    const args = { activeIndex: 3, overIndex: 2, activeNodeRect: rects[3]!, rects };
    expect(strategy({ ...args, index: 2 })?.y).toBe(111);
  });
});
