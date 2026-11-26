import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as LinearApi from "./LinearApi.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
        const operation = /^(?:query|mutation) (\w+)/.exec(JSON.parse(text).query)?.[1] ?? "?";
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
