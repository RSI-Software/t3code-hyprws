import { describe, expect, it } from "vite-plus/test";
import type { SidebarListItem } from "./Sidebar.logic";
import { applySidebarThreadGroupsFork } from "./Sidebar.workingShelf.fork";

const row = (key: string, section: "active" | "working"): SidebarListItem => ({
  kind: "thread",
  key,
  section,
});
const rows = (): SidebarListItem[] => [
  { kind: "marker", marker: "pinned-divider" },
  { kind: "marker", marker: "active-placeholder" },
  ...["child", "plain", "parent"].map((key) => row(key, "active")),
  { kind: "marker", marker: "working-header" },
  ...["working-child", "working-parent"].map((key) => row(key, "working")),
  { kind: "marker", marker: "settled-header" },
];

describe("upstream sidebar row projection", () => {
  it("orders group members by layout, hides collapsed children, and retains shelf boundaries", () => {
    const items = rows();
    applySidebarThreadGroupsFork(items, {
      activeKeys: ["plain", "parent", "child"],
      workingKeys: ["working-parent"],
      activeGroups: [],
    });
    expect(items).toEqual([
      { kind: "marker", marker: "pinned-divider" },
      { kind: "marker", marker: "active-placeholder" },
      ...["plain", "parent", "child"].map((key) => row(key, "active")),
      { kind: "marker", marker: "working-header" },
      row("working-parent", "working"),
      { kind: "marker", marker: "settled-header" },
    ]);
  });

  it("leaves project-folder rows alone and keeps a collapsed Working header", () => {
    const items = rows();
    applySidebarThreadGroupsFork(items, { activeKeys: null, workingKeys: [], activeGroups: [] });
    expect(items).toEqual(
      rows().filter((item) => item.kind !== "thread" || item.section !== "working"),
    );
    const empty: SidebarListItem[] = [];
    applySidebarThreadGroupsFork(empty, {
      activeKeys: ["hidden"],
      workingKeys: [],
      activeGroups: [],
    });
    expect(empty).toEqual([]);
  });
});
