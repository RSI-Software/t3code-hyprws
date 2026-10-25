import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import {
  applyThreadGroupMutationFork,
  type ThreadGroupFork,
  type ThreadGroupMutationFork,
  ThreadGroupTitleGenerationInput,
} from "./threadGroups.fork.ts";

describe("thread group parents", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => ThreadId.make(id)) as [
    ThreadId,
    ThreadId,
    ThreadId,
  ];
  const group: ThreadGroupFork = { id: "g", title: "G", threadIds: [a, b, c], parentThreadId: a };
  const apply = (mutation: ThreadGroupMutationFork) =>
    applyThreadGroupMutationFork([group], mutation, () => "new");

  it("swaps the lead between members, and never to an outsider", () => {
    expect(apply({ type: "set-parent", groupId: "g", parentThreadId: b })).toEqual({
      groups: [{ ...group, parentThreadId: b }],
    });
    expect(
      apply({ type: "set-parent", groupId: "g", parentThreadId: ThreadId.make("x") }),
    ).toHaveProperty("error._tag", "ThreadGroupParentNotMemberErrorFork");
  });

  it("hands the lead on when the parent rejoins as a child", () => {
    const rejoined = apply({
      type: "set-membership",
      threadIds: [a],
      target: { type: "existing", groupId: "g" },
    });
    expect(rejoined).toEqual({ groups: [{ ...group, threadIds: [b, c, a], parentThreadId: b }] });
  });

  it("keeps a group when every member moves back into it", () => {
    const reordered = apply({
      type: "set-membership",
      threadIds: [c, a, b],
      target: { type: "existing", groupId: "g", asParent: true },
    });
    expect(reordered).toEqual({ groups: [{ ...group, threadIds: [c, a, b], parentThreadId: c }] });
  });
});

describe("thread group title generation HTTP contract", () => {
  it("trims titles and requires at least two threads, counting the parent", () => {
    const decode = Schema.decodeUnknownSync(ThreadGroupTitleGenerationInput);
    expect(
      decode({
        projectId: "project-1",
        memberTitles: [" First thread ", "Second thread"],
        previousTitle: " Existing group ",
      }),
    ).toEqual({
      projectId: "project-1",
      memberTitles: ["First thread", "Second thread"],
      previousTitle: "Existing group",
    });
    expect(() => decode({ projectId: "project-1", memberTitles: ["Only thread"] })).toThrow();
    expect(
      decode({ projectId: "project-1", memberTitles: ["Child"], parentTitle: " Parent " }),
    ).toEqual({ projectId: "project-1", memberTitles: ["Child"], parentTitle: "Parent" });
  });
});
