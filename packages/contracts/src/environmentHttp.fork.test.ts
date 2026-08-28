import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadGroupTitleGenerationInput } from "./environmentHttp.ts";
describe("thread group title generation HTTP contract", () => {
  it("trims titles and requires at least two group members", () => {
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
  });
});
