import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
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
  stateRef: { id: "s-review" },
  team: { states: { nodes: [] } },
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

const state = (id: string, type: string, position: number) => ({
  id,
  name: id,
  type,
  color: null,
  position,
});

/** `saved` is the key in Settings; empty defers to the environment's. */
function makeService(env: Record<string, string>, answer: (body: any) => unknown, saved = "") {
  const requests: Array<{
    authorization: string | undefined;
    expiry: string | undefined;
    body: any;
  }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = JSON.parse(new TextDecoder().decode((request.body as any).body));
      requests.push({
        authorization: request.headers.authorization,
        expiry: request.headers["public-file-urls-expire-in"],
        body,
      });
      return HttpClientResponse.fromWeb(request, Response.json(answer(body)));
    }),
  );
  return LinearIssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        ServerSettings.layerTest({ linearApiKey: saved }),
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
                  description:
                    "Steps\n\n+++ Agent <notes>\n\n* trace\n\n+++\n\n```md\n``` still code\n\t```\n+++ Literal\nkept\n+++\n```\n\n  ~~~\n    ~~~\n+++ Indented\nkept\n+++\n  ~~~",
                  team: {
                    states: {
                      nodes: [
                        state("Done", "completed", 0),
                        state("In Review", "started", 2),
                        state("In Progress", "started", 1),
                        state("Backlog", "backlog", 0),
                      ],
                    },
                  },
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
      // Signed upload URLs, so the client shows description images without the key.
      assert.strictEqual(requests[0]?.expiry, "86400");
      assert.deepStrictEqual(requests[0]?.body.variables, { id: "ENG-42" });
      assert.deepStrictEqual(requests[1]?.body.variables, { after: "c1", id: "ENG-42" });
      assert.strictEqual(detail.commentCount, 3);
      assert.include(detail, {
        repository: "acme/eng",
        state: "open",
        closeReason: null,
        body: "Steps\n\n<details>\n<summary>Agent &lt;notes&gt;</summary>\n\n\n* trace\n\n\n</details>\n\n```md\n``` still code\n\t```\n+++ Literal\nkept\n+++\n```\n\n  ~~~\n    ~~~\n+++ Indented\nkept\n+++\n  ~~~",
        projectId: PROJECT.id,
      });
      assert.deepStrictEqual(
        detail.workflowStates?.map((entry) => entry.name),
        ["Backlog", "In Progress", "In Review", "Done"],
      );
      assert.deepStrictEqual(detail.workflowState, {
        id: "s-review",
        name: "In Review",
        color: "#f2c94c",
      });
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
      assert.include(error.message, "Linear API key");
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

  it.effect(
    "moves this workspace's issue to the named state, or the first of the folded kind",
    () =>
      Effect.gen(function* () {
        const team = {
          states: {
            nodes: [
              state("Canceled", "canceled", 0),
              state("Done", "completed", 0),
              state("In Review", "started", 0),
            ],
          },
        };
        const { service, requests } = yield* makeService({ LINEAR_API_KEY: "lin_api_x" }, (body) =>
          body.variables.stateId === undefined
            ? { data: { issue: { url: issue().url, team } } }
            : { data: { issueUpdate: { success: true } } },
        );
        const elsewhere = yield* makeService({ LINEAR_API_KEY: "lin_api_x" }, (body) =>
          body.variables.stateId === undefined
            ? { data: { issue: { url: "https://linear.app/other/issue/ENG-42/fix-login", team } } }
            : { data: { issueUpdate: { success: true } } },
        );
        const ref = { projectId: PROJECT.id, repository: "acme/eng", number: 42 };

        yield* service.setState({ ...ref, state: "open", workflowStateId: "In Review" });
        yield* service.setState({ ...ref, state: "closed", reason: "not planned" });
        const missing = yield* service.setState({ ...ref, state: "open" }).pipe(Effect.flip);
        const foreign = yield* elsewhere.service
          .setState({ ...ref, state: "open", workflowStateId: "In Review" })
          .pipe(Effect.flip);

        assert.deepStrictEqual(
          requests.map((request) => request.body.variables),
          [
            { id: "ENG-42" },
            { id: "ENG-42", stateId: "In Review" },
            { id: "ENG-42" },
            { id: "ENG-42", stateId: "Canceled" },
            { id: "ENG-42" },
          ],
        );
        assert.include(missing.message, "no workflow state");
        assert.include(foreign.message, "not found");
        assert.deepStrictEqual(
          elsewhere.requests.map((request) => request.body.variables),
          [{ id: "ENG-42" }],
        );
      }),
  );

  it.effect("prefers the key saved in Settings over the environment's", () =>
    Effect.gen(function* () {
      const answer = () => ({ data: { issue: issue() } });
      const env = { LINEAR_API_KEY: "lin_api_env" };

      const saved = yield* makeService(env, answer, "lin_api_saved");
      yield* saved.service.reference(KEY);
      const blank = yield* makeService(env, answer);
      yield* blank.service.reference(KEY);

      assert.strictEqual(saved.requests[0]?.authorization, "lin_api_saved");
      assert.strictEqual(blank.requests[0]?.authorization, "lin_api_env");
    }),
  );
});
