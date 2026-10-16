import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  TEXT_GENERATION_TIMEOUT_MS_FORK,
  THREAD_GROUP_TITLE_CLIENT_TIMEOUT_MS_FORK,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { fetchEnvironmentThreadGroupTitle } from "./threadGroupTitleHttp.ts";

it.effect("gives the server time to report its group-title deadline before the client aborts", () =>
  Effect.gen(function* () {
    let interrupted = false;
    const client = HttpClient.make(() =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Test environment",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    });
    const pending = yield* fetchEnvironmentThreadGroupTitle({
      prepared: {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: "wss://environment.example.test/ws",
        httpAuthorization: null,
        target,
      },
      signer: Option.none(),
      request: { projectId: ProjectId.make("project-1"), memberTitles: ["Ordering", "Groups"] },
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(TEXT_GENERATION_TIMEOUT_MS_FORK);
    expect(interrupted).toBe(false);
    yield* TestClock.adjust(
      THREAD_GROUP_TITLE_CLIENT_TIMEOUT_MS_FORK - TEXT_GENERATION_TIMEOUT_MS_FORK,
    );
    expect(yield* Fiber.join(pending)).toMatchObject({
      _tag: "RemoteEnvironmentAuthTimeoutError",
      timeoutMs: THREAD_GROUP_TITLE_CLIENT_TIMEOUT_MS_FORK,
    });
    expect(interrupted).toBe(true);
  }),
);
