import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as LinearIssueService from "./LinearIssueService.fork.ts";

const KEY = { host: "linear.app", repository: "acme/eng", number: 42 };
const PROJECT = {
  id: ProjectId.make("project-1"),
  title: "App",
  workspaceRoot: "/repo",
} as OrchestrationProjectShell;

const actor = (name: string) => ({ name, displayName: name.toLowerCase(), avatarUrl: null });
const issue = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: "Fix login",
  url: "https://linear.app/acme/issue/ENG-42/fix-login",
  state: { name: "In Review", type: "started", color: "#f2c94c" },
  labels: { nodes: [{ name: "Bug", color: "#eb5757" }] },
  identifier: "ENG-42",
  description: "Steps",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  creator: actor("Ada"),
  assignee: null,
  comments: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      {
        id: "c2",
        body: "second",
        createdAt: "2026-11-02T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
        url: "https://linear.app/acme/issue/ENG-42#comment-c2",
        user: actor("Bo"),
      },
      {
        id: "c1",
        body: "first",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        url: "https://linear.app/acme/issue/ENG-42#comment-c1",
        user: null,
      },
    ],
  },
  ...overrides,
});

function makeService(env: Record<string, string>, answer: (body: any) => unknown) {
  const requests: Array<{ authorization: string | undefined; body: any }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = JSON.parse(new TextDecoder().decode((request.body as any).body));
      requests.push({ authorization: request.headers.authorization, body });
      return HttpClientResponse.fromWeb(request, Response.json(answer(body)));
    }),
  );
  return LinearIssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
    Effect.map((service) => ({ service, requests })),
  );
}

describe("LinearIssueService", () => {
  it.effect("reads a detail with the server's key, folding its workflow state", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* makeService({ LINEAR_API_KEY: "lin_api_x" }, (body) =>
        body.variables.after === undefined
          ? {
              data: {
                issue: issue({
                  comments: {
                    ...issue().comments,
                    pageInfo: { hasNextPage: true, endCursor: "c1" },
                  },
                }),
              },
            }
          : {
              data: {
                issue: {
                  url: issue().url,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ id: "c0" }],
                  },
                },
              },
            },
      );
      const detail = yield* service.detail(KEY, PROJECT);

      assert.deepStrictEqual(requests[0]?.authorization, "lin_api_x");
      assert.deepStrictEqual(requests[0]?.body.variables, { id: "ENG-42" });
      assert.deepStrictEqual(requests[1]?.body.variables, { after: "c1", id: "ENG-42" });
      assert.strictEqual(detail.commentCount, 3);
      assert.include(detail, {
        repository: "acme/eng",
        state: "open",
        closeReason: null,
        body: "Steps",
        projectId: PROJECT.id,
      });
      assert.deepStrictEqual(detail.workflowState, { name: "In Review", color: "#f2c94c" });
      assert.deepStrictEqual(
        detail.comments.map((comment) => comment.id),
        ["c1", "c2"],
      );
    }),
  );

  it.effect("finds nothing in another workspace, and refuses without a key", () =>
    Effect.gen(function* () {
      const other = yield* makeService({ LINEAR_API_KEY: "lin_api_x" }, () => ({
        data: { issue: issue({ url: "https://linear.app/other/issue/ENG-42/fix-login" }) },
      }));
      assert.isNull(yield* other.service.reference(KEY));

      const failing = yield* makeService({ LINEAR_API_KEY: "lin_api_x" }, () => ({
        data: { issue: null },
        errors: [{ message: "internal trace id 7f3a" }],
      }));
      const refused = yield* failing.service.reference(KEY).pipe(Effect.flip);
      assert.notInclude(refused.message, "7f3a");

      const keyless = yield* makeService({ LINEAR_API_KEY: " " }, () => {
        throw new Error("no request without a key");
      });
      const error = yield* keyless.service.detail(KEY, PROJECT).pipe(Effect.flip);
      assert.include(error.message, "LINEAR_API_KEY");
      assert.strictEqual(
        (yield* keyless.service.summaries({ repository: "acme/eng", numbers: [42] })).size,
        0,
      );
    }),
  );

  it.effect("summarizes one team's issues, done and canceled as closed", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* makeService({ LINEAR_API_KEY: "lin_api_x" }, () => ({
        data: {
          issues: {
            nodes: [
              issue(),
              issue({ number: 7, state: { name: "Done", type: "completed", color: null } }),
              issue({ number: 8, state: { name: "Canceled", type: "canceled", color: null } }),
            ],
          },
        },
      }));
      const found = yield* service.summaries({ repository: "acme/eng", numbers: [42, 7, 8, 42] });

      assert.deepStrictEqual(requests[0]?.body.variables, { team: "ENG", numbers: [42, 7, 8] });
      assert.include(requests[0]?.body.query, "includeArchived: true");
      assert.deepStrictEqual(
        [...found].map(([number, summary]) => [number, summary.state, summary.closeReason]),
        [
          [42, "open", null],
          [7, "closed", "completed"],
          [8, "closed", "not planned"],
        ],
      );
    }),
  );
});
