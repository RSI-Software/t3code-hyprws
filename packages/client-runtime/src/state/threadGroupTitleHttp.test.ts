import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentThreadGroupTitle } from "./threadGroupTitleHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

describe("fetchEnvironmentThreadGroupTitle", () => {
  it.effect("posts member titles to the prepared environment", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json({ title: "Sidebar organization" }));
      }) satisfies typeof fetch;

      const result = yield* fetchEnvironmentThreadGroupTitle({
        prepared: PREPARED,
        signer: Option.none(),
        request: {
          projectId: ProjectId.make("project-1"),
          memberTitles: ["Manual ordering", "Visual groups"],
          previousTitle: "Related work",
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(result).toEqual({ title: "Sidebar organization" });
      expect(calls).toHaveLength(1);
      const [request, init] = calls[0]!;
      expect(String(request)).toBe(
        "https://environment.example.test/api/orchestration/thread-group-title",
      );
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
    }),
  );
});
