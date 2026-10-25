import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readLegacyThreadGroupsFork, splitLegacyThreadGroupsFork } from "./threadGroupsLegacy.fork";

const here = EnvironmentId.make("here");

describe("legacy thread groups", () => {
  it("reads either saved shape and drops malformed groups", () => {
    const group = { id: "g1", title: "Work", threadIds: ["here:a", "here:b"] };
    expect(readLegacyThreadGroupsFork({ threadGroups: [group, { id: "", title: "x" }] })).toEqual([
      group,
    ]);
    expect(
      readLegacyThreadGroupsFork({
        threadGroupsByProject: { p1: [group], p2: [{ ...group, id: "g2" }] },
      }),
    ).toEqual([group, { ...group, id: "g2" }]);
  });

  it("imports an environment's share and keeps the rest pending", () => {
    const { share, remaining } = splitLegacyThreadGroupsFork(
      [
        {
          id: "mixed",
          title: "Mixed",
          threadIds: ["here:a", "here:b", "there:c", "there:d"],
          parentThreadId: "there:c",
          collapsed: true,
        },
        {
          id: "lonely",
          title: "Lonely",
          threadIds: ["here:e", "there:f"],
          parentThreadId: "here:e",
        },
      ],
      here,
    );
    expect(share).toEqual([
      { imported: { id: "mixed", title: "Mixed", threadIds: ["a", "b"] }, collapsed: true },
    ]);
    expect(remaining).toEqual([
      {
        id: "mixed",
        title: "Mixed",
        threadIds: ["there:c", "there:d"],
        parentThreadId: "there:c",
        collapsed: true,
      },
    ]);
  });
});
