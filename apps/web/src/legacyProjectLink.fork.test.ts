import { describe, expect, it } from "vite-plus/test";

import { decodeLegacyProjectLink } from "./legacyProjectLink.fork";

const HOME = { to: "/" };

describe("decodeLegacyProjectLink", () => {
  it.each([
    ["project root", "/project/env-1/project-1", HOME],
    ["project root with a trailing slash", "/project/env-1/project-1/", HOME],
    [
      "thread",
      "/project/env-1/project-1/thread/thread-1",
      { to: "/$environmentId/$threadId", params: { environmentId: "env-1", threadId: "thread-1" } },
    ],
    [
      "thread from a hash route",
      "#/project/env-1/project-1/thread/thread-1",
      { to: "/$environmentId/$threadId", params: { environmentId: "env-1", threadId: "thread-1" } },
    ],
    [
      "thread from a slash-prefixed hash route",
      "/#/project/env-1/project-1/thread/thread-1",
      { to: "/$environmentId/$threadId", params: { environmentId: "env-1", threadId: "thread-1" } },
    ],
    [
      "thread with escaped ids",
      "/project/remote%3Awsl/project%20one/thread/thread%2F1",
      {
        to: "/$environmentId/$threadId",
        params: { environmentId: "remote:wsl", threadId: "thread/1" },
      },
    ],
    [
      "draft",
      "/project/env-1/project-1/draft/draft-1",
      { to: "/draft/$draftId", params: { draftId: "draft-1" } },
    ],
    [
      "desktop manifest draft as a hash route",
      "#/project/env-1/project-1/draft/draft-1",
      { to: "/draft/$draftId", params: { draftId: "draft-1" } },
    ],
  ])("%s", (_name, pathname, expected) => {
    expect(decodeLegacyProjectLink(pathname)).toStrictEqual(expected);
  });

  it.each([
    ["issues", "/issues"],
    ["pull-requests", "/pull-requests"],
  ] as const)("%s keeps its project as a plain filter", (kind, to) => {
    expect(
      decodeLegacyProjectLink(`/project/env-1/project-1/${kind}`, { state: "closed", q: "bug" }),
    ).toStrictEqual({
      to,
      search: { state: "closed", q: "bug", projectId: "project-1", environmentId: "env-1" },
    });
  });

  it.each([
    ["issues", "/issues"],
    ["pull-requests", "/pull-requests"],
  ] as const)("%s with scope=all drops the scope and the project", (kind, to) => {
    expect(
      decodeLegacyProjectLink(`/project/env-1/project-1/${kind}`, {
        scope: "all",
        state: "open",
        selectedProjectId: "project-2",
      }),
    ).toStrictEqual({ to, search: { state: "open", selectedProjectId: "project-2" } });
  });

  it("drops any other scope value while keeping the project filter", () => {
    expect(
      decodeLegacyProjectLink("/project/env-1/project-1/issues", { scope: "project" }),
    ).toStrictEqual({
      to: "/issues",
      search: { projectId: "project-1", environmentId: "env-1" },
    });
  });

  it.each([
    ["not a project link", "/settings"],
    ["environment only", "/project/env-1"],
    ["empty project", "/project/env-1//thread/thread-1"],
    ["space-padded project", "/project/env-1/%20project/thread/thread-1"],
    ["thread without an id", "/project/env-1/project-1/thread"],
    ["draft without an id", "/project/env-1/project-1/draft/"],
    ["unknown kind", "/project/env-1/project-1/settings"],
    ["extra tail", "/project/env-1/project-1/thread/thread-1/extra"],
    ["issues with an id", "/project/env-1/project-1/issues/12"],
  ])("%s lands home", (_name, pathname) => {
    expect(decodeLegacyProjectLink(pathname)).toStrictEqual(HOME);
  });
});
