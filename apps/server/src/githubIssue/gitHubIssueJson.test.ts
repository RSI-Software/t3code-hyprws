import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import issue152Fixture from "./__fixtures__/issue-152.json" with { type: "json" };
import { decodeGitHubIssueDetail, decodeGitHubIssueList } from "./gitHubIssueJson.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const rawIssue = {
  number: 42,
  title: "Support GitHub issues",
  url: "https://github.com/t3tools/t3code/issues/42",
  author: { login: "octocat", name: "Octo Cat" },
  assignees: [{ login: "maintainer" }],
  labels: [{ name: "feature", color: "1d76db" }],
  state: "OPEN",
  createdAt: "2026-08-20T00:00:00Z",
  updatedAt: "2026-08-21T00:00:00Z",
};

describe("GitHub issue JSON", () => {
  it.effect("normalizes list actors, labels, and state", () =>
    Effect.gen(function* () {
      const [issue] = yield* decodeGitHubIssueList(encodeJson([rawIssue]));

      expect(issue).toMatchObject({
        number: 42,
        state: "open",
        author: { login: "octocat", avatarUrl: null },
        assignees: [{ login: "maintainer", name: null, avatarUrl: null }],
        labels: [{ name: "feature", color: "1d76db" }],
      });
    }),
  );

  it.effect("degrades blank actors without failing the batch", () =>
    Effect.gen(function* () {
      const [issue] = yield* decodeGitHubIssueList(
        encodeJson([
          {
            ...rawIssue,
            author: { login: "   " },
            assignees: [{ login: "" }, { login: " maintainer " }],
          },
        ]),
      );

      expect(issue?.author).toBeNull();
      expect(issue?.assignees).toEqual([{ login: "maintainer", name: null, avatarUrl: null }]);
    }),
  );

  it.effect("normalizes optional actor fields in comments", () =>
    Effect.gen(function* () {
      const issue = yield* decodeGitHubIssueDetail(
        encodeJson({
          ...rawIssue,
          body: "Please make issues visible.",
          closedAt: null,
          comments: [
            {
              id: "comment-1",
              author: { login: "reviewer" },
              body: "This should open an agent thread.",
              createdAt: "2026-08-21T01:00:00Z",
              updatedAt: "2026-08-21T02:00:00Z",
              url: `${rawIssue.url}#issuecomment-comment-1`,
            },
          ],
        }),
      );

      expect(issue.body).toBe("Please make issues visible.");
      expect(issue.comments[0]).toMatchObject({
        id: "comment-1",
        author: { name: null, avatarUrl: null },
        updatedAt: "2026-08-21T02:00:00Z",
        url: `${rawIssue.url}#issuecomment-comment-1`,
      });
    }),
  );

  it.effect("decodes the real gh payload for an issue with comments", () =>
    Effect.gen(function* () {
      const issue = yield* decodeGitHubIssueDetail(encodeJson(issue152Fixture));

      expect(issue.number).toBe(152);
      expect(issue.comments).toHaveLength(2);
      expect(issue.comments[0]).toMatchObject({
        id: "IC_kwDOR2R_p88AAAABPP9J-Q",
        createdAt: "2026-08-17T17:48:35Z",
        updatedAt: "2026-08-17T17:48:35Z",
      });
    }),
  );

  it.effect("defaults absent detail fields without changing markdown", () =>
    Effect.gen(function* () {
      const issue = yield* decodeGitHubIssueDetail(encodeJson(rawIssue));
      expect(issue.body).toBe("");
      expect(issue.comments).toStrictEqual([]);
      expect(issue.subIssues).toStrictEqual([]);
      expect(issue.issueType).toBeNull();
      expect(issue.closedAt).toBeNull();
    }),
  );

  it.effect("normalizes the issue type and the sub-issue hierarchy", () =>
    Effect.gen(function* () {
      const issue = yield* decodeGitHubIssueDetail(
        encodeJson({
          ...rawIssue,
          issueType: { id: "IT_1", name: "Bug \u{1F41B}", description: "A problem", color: "RED" },
          subIssues: {
            nodes: [
              {
                id: "I_1",
                number: 43,
                title: "Render the list",
                url: `${rawIssue.url.replace("42", "43")}`,
                state: "OPEN",
              },
            ],
          },
        }),
      );

      expect(issue.issueType).toStrictEqual({ name: "Bug \u{1F41B}", color: "RED" });
      expect(issue.subIssues).toStrictEqual([
        {
          number: 43,
          title: "Render the list",
          url: "https://github.com/t3tools/t3code/issues/43",
          state: "open",
        },
      ]);
    }),
  );

  it.effect("rejects a comment missing its URL", () => {
    const comment = {
      id: "comment-1",
      author: null,
      body: "Malformed comment",
      createdAt: "2026-08-21T01:00:00Z",
      updatedAt: "2026-08-21T02:00:00Z",
    };

    return Effect.gen(function* () {
      const exit = yield* decodeGitHubIssueDetail(
        encodeJson({ ...rawIssue, comments: [comment] }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.effect.each([
    { name: "unknown state", patch: { state: "MERGED" } },
    { name: "non-positive number", patch: { number: 0 } },
    { name: "malformed date", patch: { updatedAt: "yesterday" } },
  ])("rejects $name", ({ patch }) =>
    Effect.gen(function* () {
      const exit = yield* decodeGitHubIssueList(encodeJson([{ ...rawIssue, ...patch }])).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
