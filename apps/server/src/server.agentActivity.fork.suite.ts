// Fork-owned HTTP cases for paginated child agent activity. `server.test.ts`
// registers them inside its router seam suite through one hook, so they reuse
// its app harness without adding test blocks to the upstream file.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type * as NodeServices from "@effect/platform-node/NodeServices";
import type { Vitest } from "@effect/vitest";
import { assert } from "@effect/vitest";
import {
  CHILD_ITEM_RENDER_JSON_MAX_BYTES,
  ChildItemRenderDetail,
  EventId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient } from "effect/unstable/http";

import { AGENT_ACTIVITY_SERIALIZED_MAX_BYTES } from "./orchestration/AgentActivityProjection.ts";
import { encodeAgentActivityPageCursor } from "./orchestration/agentActivityCursor.ts";
import { makeChildItemRenderDetail } from "./provider/childItemRenderDetail.ts";
import type { AgentActivityHarnessFork } from "./server.test.ts";

const encodeChildItemRenderDetailJson = Schema.encodeSync(
  Schema.fromJsonString(ChildItemRenderDetail),
);
const childItemRenderDetailBytes = (detail: ChildItemRenderDetail) =>
  new TextEncoder().encode(encodeChildItemRenderDetailJson(detail)).length;

export const agentActivityTestsFork = (
  it: Vitest.MethodsNonLive<NodeServices.NodeServices>,
  {
    buildAppUnderTest,
    getAuthenticatedSessionCookieHeader,
    exchangeAccessToken,
    defaultDesktopBootstrapToken,
    getHttpServerUrl,
    fetchEffect,
    responseJsonEffect,
    encodeTestJson,
  }: AgentActivityHarnessFork,
) => {
  it.effect("serves bounded agent activity only with orchestration read access", () =>
    Effect.gen(function* () {
      const hostile = '\u0000\n"\\'.repeat(8_000);
      const boundedRenderDetail = makeChildItemRenderDetail({
        workspaceRoot: "/workspace/project",
        command: hostile,
        result: hostile,
        changedFiles: [{ path: "/workspace/project/src/codex.ts", diff: hostile }],
      });
      assert.ok(boundedRenderDetail);
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getAgentActivitySnapshot: (threadId, agentId, window) => {
              if (threadId !== ThreadId.make("thread-1") || agentId !== "agent-1") {
                return Effect.succeed(Option.none());
              }
              assert.equal(window.limit, 3);
              return Effect.succeed(
                Option.some({
                  agentId,
                  activities: [
                    {
                      id: EventId.make(`activity-${"a".repeat(30_000)}`),
                      tone: "tool" as const,
                      kind: "tool.completed",
                      summary: "Read /home/alice/private/file.ts",
                      payload: {
                        agentId,
                        runHandles: { scriptPath: "/home/alice/workflow.js" },
                        values: Array.from({ length: 20 }, () =>
                          Array.from({ length: 20 }, () =>
                            Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 1)),
                          ),
                        ),
                      },
                      turnId: TurnId.make(`turn-${"t".repeat(30_000)}`),
                      sequence: 7,
                      createdAt: `2026-08-28T00:00:00.${"1".repeat(30_000)}Z`,
                    },
                    {
                      id: EventId.make("activity-2"),
                      tone: "tool" as const,
                      kind: "tool.completed",
                      summary: "Codex child edit",
                      payload: { agentId, renderDetail: boundedRenderDetail },
                      turnId: null,
                      sequence: 8,
                      createdAt: "2026-08-28T00:00:01.000Z",
                    },
                    {
                      id: EventId.make("activity-3"),
                      tone: "tool" as const,
                      kind: "tool.completed",
                      summary: "Claude child edit",
                      payload: {
                        agentId,
                        renderDetail: {
                          result: "updated src/claude.ts",
                          changedFiles: [
                            { path: "src/claude.ts", kind: "modified", diff: "+updated" },
                          ],
                          truncated: false,
                        },
                      },
                      turnId: null,
                      sequence: 9,
                      createdAt: "2026-08-28T00:00:02.000Z",
                    },
                  ],
                  page: {
                    beforeCursor: null,
                    hasMore: false,
                    snapshotSequence: 9,
                    threadSequence: 9,
                  },
                }),
              );
            },
          },
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const deniedCredentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({ scopes: ["access:read"] }),
      });
      const deniedCredential = (yield* deniedCredentialResponse.json) as {
        readonly credential: string;
      };
      const denied = yield* exchangeAccessToken(deniedCredential.credential, {
        scope: "access:read",
      });
      const allowed = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });
      const endpoint = yield* getHttpServerUrl(
        "/api/orchestration/threads/thread-1/agents/agent-1/activities?limit=3",
      );
      const allowedResponse = yield* fetchEffect(endpoint, {
        headers: { authorization: `Bearer ${allowed.body.access_token ?? ""}` },
      });
      const allowedBody = yield* responseJsonEffect<{
        readonly activities: ReadonlyArray<{
          readonly summary: string;
          readonly payload: unknown;
          readonly truncated: boolean;
        }>;
      }>(allowedResponse);
      const deniedResponse = yield* fetchEffect(endpoint, {
        headers: { authorization: `Bearer ${denied.body.access_token ?? ""}` },
      });
      const deniedBody = yield* responseJsonEffect<{ readonly requiredScope: string }>(
        deniedResponse,
      );
      const missingResponse = yield* fetchEffect(endpoint.replace("agent-1", "missing-agent"), {
        headers: { authorization: `Bearer ${allowed.body.access_token ?? ""}` },
      });
      const missingBody = yield* responseJsonEffect<{ readonly reason: string }>(missingResponse);
      const malformedCursorResponse = yield* fetchEffect(`${endpoint}&beforeCursor=not-a-cursor`, {
        headers: { authorization: `Bearer ${allowed.body.access_token ?? ""}` },
      });
      const malformedCursorBody = yield* responseJsonEffect<{ readonly reason: string }>(
        malformedCursorResponse,
      );
      const crossThreadCursor = encodeAgentActivityPageCursor({
        threadId: ThreadId.make("thread-2"),
        agentId: "agent-1",
        beforeSequence: 7,
        beforeCreatedAt: "2026-08-28T00:00:00.000Z",
        beforeActivityId: "activity-1",
      });
      const crossThreadCursorResponse = yield* fetchEffect(
        `${endpoint}&beforeCursor=${encodeURIComponent(crossThreadCursor)}`,
        { headers: { authorization: `Bearer ${allowed.body.access_token ?? ""}` } },
      );
      const crossThreadCursorBody = yield* responseJsonEffect<{ readonly reason: string }>(
        crossThreadCursorResponse,
      );
      const crossAgentCursor = encodeAgentActivityPageCursor({
        threadId: ThreadId.make("thread-1"),
        agentId: "agent-2",
        beforeSequence: 7,
        beforeCreatedAt: "2026-08-28T00:00:00.000Z",
        beforeActivityId: "activity-1",
      });
      const crossAgentCursorResponse = yield* fetchEffect(
        `${endpoint}&beforeCursor=${encodeURIComponent(crossAgentCursor)}`,
        { headers: { authorization: `Bearer ${allowed.body.access_token ?? ""}` } },
      );
      const crossAgentCursorBody = yield* responseJsonEffect<{ readonly reason: string }>(
        crossAgentCursorResponse,
      );
      const nonCanonicalCursor = `${encodeAgentActivityPageCursor({
        threadId: ThreadId.make("thread-1"),
        agentId: "agent-1",
        beforeSequence: 7,
        beforeCreatedAt: "2026-08-28T00:00:00.000Z",
        beforeActivityId: "activity-1",
      })}=`;
      const nonCanonicalCursorResponse = yield* fetchEffect(
        `${endpoint}&beforeCursor=${encodeURIComponent(nonCanonicalCursor)}`,
        { headers: { authorization: `Bearer ${allowed.body.access_token ?? ""}` } },
      );
      const nonCanonicalCursorBody = yield* responseJsonEffect<{ readonly reason: string }>(
        nonCanonicalCursorResponse,
      );

      assert.equal(allowedResponse.status, 200);
      const allowedActivities = allowedBody.activities;
      assert.equal(allowedActivities[0]?.summary, "Read [local path]");
      assert.equal(allowedActivities[0]?.truncated, true);
      const allowedPayload = allowedActivities[0]?.payload as
        | {
            readonly agentId?: string;
            readonly runHandles?: unknown;
            readonly values?: unknown;
          }
        | undefined;
      assert.equal(allowedPayload?.agentId, "agent-1");
      assert.deepEqual(allowedPayload?.runHandles, {});
      assert.isArray(allowedPayload?.values);
      assert.isAtMost(
        Buffer.byteLength(encodeTestJson(allowedActivities[0]), "utf8"),
        AGENT_ACTIVITY_SERIALIZED_MAX_BYTES,
      );
      assert.deepEqual(allowedActivities[1]?.payload, {
        agentId: "agent-1",
        renderDetail: boundedRenderDetail,
      });
      assert.ok(
        childItemRenderDetailBytes(boundedRenderDetail) <= CHILD_ITEM_RENDER_JSON_MAX_BYTES,
      );
      assert.deepEqual(allowedActivities[2]?.payload, {
        agentId: "agent-1",
        renderDetail: {
          result: "updated src/claude.ts",
          changedFiles: [{ path: "src/claude.ts", kind: "modified", diff: "+updated" }],
          truncated: false,
        },
      });
      for (const activity of allowedActivities) {
        assert.isAtMost(
          Buffer.byteLength(encodeTestJson(activity), "utf8"),
          AGENT_ACTIVITY_SERIALIZED_MAX_BYTES,
        );
      }
      assert.equal(deniedResponse.status, 403);
      assert.equal(deniedBody.requiredScope, "orchestration:read");
      assert.equal(missingResponse.status, 404);
      assert.equal(missingBody.reason, "agent_not_found");
      assert.equal(malformedCursorResponse.status, 400);
      assert.equal(malformedCursorBody.reason, "invalid_agent_activity_cursor");
      assert.equal(crossThreadCursorResponse.status, 400);
      assert.equal(crossThreadCursorBody.reason, "invalid_agent_activity_cursor");
      assert.equal(crossAgentCursorResponse.status, 400);
      assert.equal(crossAgentCursorBody.reason, "invalid_agent_activity_cursor");
      assert.equal(nonCanonicalCursorResponse.status, 400);
      assert.equal(nonCanonicalCursorBody.reason, "invalid_agent_activity_cursor");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
};
