import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as LinearApi from "./LinearApi.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const issueNode = (identifier: string) => ({
  id: identifier,
  identifier,
  number: Number(identifier.split("-")[1]),
  title: `Title of ${identifier}`,
  url: `https://linear.app/acme/issue/${identifier}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  state: { id: "s", name: "Todo", type: "unstarted", position: 0 },
  team: { key: "ENG" },
  creator: null,
  botActor: null,
  assignee: null,
  labels: { nodes: [] },
});

/** Counts each GraphQL operation sent; `fail` makes the next issue read a server error. */
function fakeLinear() {
  const sent: Array<string> = [];
  const state = { token: "lin_api_one", fail: false };
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body;
        const text = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
        const { query, variables } = JSON.parse(text);
        const operation = /^(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "?";
        sent.push(`${operation} ${request.headers.authorization}`);
        const answer =
          operation === "T3Viewer"
            ? json({
                data: {
                  viewer: { id: "u", name: "u", displayName: "u", email: "u@x", avatarUrl: null },
                  organization: { urlKey: "acme" },
                  teams: { nodes: [] },
                },
              })
            : operation === "T3Issues"
              ? json({
                  data: {
                    issues: {
                      nodes: variables.filter.id.in
                        .filter((identifier: string) => identifier !== "ENG-404")
                        .map(issueNode),
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                })
              : operation === "T3IssueUpdate"
                ? json({ data: { issueUpdate: { success: true } } })
                : state.fail
                  ? ((state.fail = false), json({ errors: [{ message: "boom" }] }, 500))
                  : json({ errors: [{ message: "Issue not found" }] });
        return HttpClientResponse.fromWeb(request, answer);
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.sync(() => Option.some(state.token)) },
    }),
  );
  const api = Effect.service(LinearApi.LinearApi).pipe(
    Effect.provide(LinearApi.layer.pipe(Layer.provide(Layer.merge(http, host)))),
  );
  return { api, sent, state };
}

describe("LinearApiReadCache", () => {
  it.effect("sends one read per issue and account, however many views ask", () =>
    Effect.gen(function* () {
      const { api: make, sent, state } = fakeLinear();
      const api = yield* make;
      yield* Effect.all(
        Array.from({ length: 5 }, () => api.getIssue("ENG-1", 20)),
        { concurrency: "unbounded" },
      );
      yield* api.getIssue("ENG-1", 20);
      yield* Effect.all([api.viewer(), api.viewer(), api.viewer("lin_api_one")]);
      expect(sent).toEqual(["T3Issue lin_api_one", "T3Viewer lin_api_one"]);

      state.token = "lin_api_two";
      yield* api.getIssue("ENG-1", 20);
      yield* api.viewer();
      expect(sent.slice(2)).toEqual(["T3Issue lin_api_two", "T3Viewer lin_api_two"]);
    }),
  );

  // Each chip's read arrives as its own request, a few milliseconds apart.
  it.effect("answers every chip in a view with one Linear call", () =>
    Effect.gen(function* () {
      const { api: make, sent } = fakeLinear();
      const api = yield* make;
      const read = (identifier: string) =>
        api.getIssueSummaryFork(identifier).pipe(Effect.map((issue) => issue?.title ?? null));
      const settled = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(effect);
          yield* TestClock.adjust("1 second");
          return yield* Fiber.join(fiber);
        });
      const titles = yield* settled(
        Effect.all([read("ENG-1"), read("ENG-2").pipe(Effect.delay("5 millis")), read("ENG-404")], {
          concurrency: "unbounded",
        }),
      );
      expect(titles).toEqual(["Title of ENG-1", "Title of ENG-2", null]);
      yield* read("ENG-1");
      expect(sent).toEqual(["T3Issues lin_api_one"]);

      yield* api.updateIssue("ENG-1", { title: "renamed" });
      yield* settled(read("ENG-1"));
      expect(sent.filter((op) => op.startsWith("T3Issues "))).toHaveLength(2);
    }),
  );

  it.effect("rereads after a write or a failed read", () =>
    Effect.gen(function* () {
      const { api: make, sent, state } = fakeLinear();
      const api = yield* make;
      yield* api.getIssue("ENG-1", 20);
      yield* api.updateIssue("ENG-1", { title: "renamed" });
      yield* api.getIssue("ENG-1", 20);
      expect(sent.filter((op) => op.startsWith("T3Issue "))).toHaveLength(2);

      state.fail = true;
      yield* Effect.flip(api.getIssue("ENG-2", 20));
      yield* api.getIssue("ENG-2", 20);
      expect(sent.filter((op) => op.startsWith("T3Issue "))).toHaveLength(4);
    }),
  );
});
