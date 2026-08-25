import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  GitHubIssueDetail,
  GitHubIssueListInput,
  GitHubIssueListProjectError,
  GitHubIssueRef,
} from "./githubIssue.ts";

const detail = {
  projectId: "project-1",
  projectTitle: "t3code",
  workspaceRoot: "/repo",
  repository: "t3tools/t3code",
  number: 42,
  title: "Support GitHub issues",
  url: "https://github.com/t3tools/t3code/issues/42",
  author: { login: "octocat", name: "Octo Cat", avatarUrl: null },
  assignees: [{ login: "maintainer", name: null, avatarUrl: "https://example.com/avatar" }],
  labels: [{ name: "feature", color: "1d76db" }],
  state: "open",
  createdAt: "2026-08-20T00:00:00Z",
  updatedAt: "2026-08-21T00:00:00Z",
  body: "Issue body",
  comments: [
    {
      id: "comment-1",
      author: null,
      body: "Comment body",
      createdAt: "2026-08-21T01:00:00Z",
      updatedAt: "2026-08-21T02:00:00Z",
      url: "https://github.com/t3tools/t3code/issues/42#issuecomment-1",
    },
  ],
  commentCount: 1,
  closedAt: null,
} as const;

describe("GitHub issue contracts", () => {
  it("decodes every issue detail field", () => {
    expect(Schema.decodeUnknownSync(GitHubIssueDetail)(detail)).toStrictEqual(detail);
  });

  it("keeps the host's true comment total when the returned comments are capped", () => {
    const decoded = Schema.decodeUnknownSync(GitHubIssueDetail)({ ...detail, commentCount: 101 });
    expect(decoded.comments).toHaveLength(1);
    expect(decoded.commentCount).toBe(101);
  });

  it.each([0, -1])("rejects non-positive issue number %s", (number) => {
    expect(() =>
      Schema.decodeUnknownSync(GitHubIssueRef)({
        projectId: "project-1",
        repository: "t3tools/t3code",
        number,
      }),
    ).toThrow();
  });

  it("bounds and trims search text", () => {
    const decode = Schema.decodeUnknownSync(GitHubIssueListInput);
    expect(decode({ state: "open", query: "  websocket  " }).query).toBe("websocket");
    expect(() => decode({ state: "open", query: "x".repeat(201) })).toThrow();
  });

  it.each([0, 101, 1.5])("rejects invalid list limit %s", (limit) => {
    expect(() => Schema.decodeUnknownSync(GitHubIssueListInput)({ state: "all", limit })).toThrow();
  });

  it("keeps the upstream project error field set", () => {
    const decoded = Schema.decodeUnknownSync(GitHubIssueListProjectError)({
      projectId: "project-1",
      projectTitle: "t3code",
      message: "Run gh auth login",
    });
    expect(Object.keys(decoded).toSorted()).toStrictEqual(["message", "projectId", "projectTitle"]);
  });
});
