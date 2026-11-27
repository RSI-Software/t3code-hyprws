import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Colleagues from "../../../collaborator/Colleagues.fork.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ColleagueToolkitHandlersLiveFork } from "./handlers.fork.ts";
import { ColleagueToolkitFork } from "./tools.fork.ts";

const unknown = new Colleagues.ColleagueUnknownNameErrorFork({ asked: "Pat", saved: ["Jo"] });
const colleagues = Layer.merge(
  Layer.mock(Colleagues.ColleaguesFork)({
    threadsOf: () => Effect.fail(unknown),
    threadOf: () => Effect.fail(unknown),
  }),
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("env-sam"),
    requestNamespace: "colleague",
    thread: undefined,
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  }),
);

it.effect("an unknown colleague is the agent's mistake on both tools", () =>
  Effect.gen(function* () {
    const toolkit = yield* ColleagueToolkitFork.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ColleagueToolkitHandlersLiveFork).pipe(
          Layer.provide(colleagues),
        ),
      ),
    );
    const threadId = ThreadId.make("shared");
    for (const failed of [
      yield* toolkit
        .handle("t3_colleague_threads", { colleague: "Pat" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(colleagues)),
      yield* toolkit
        .handle("t3_colleague_thread_read", { colleague: "Pat", threadId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(colleagues)),
    ]) {
      expect(failed).toMatchObject([
        { isFailure: true, result: { code: "invalid_request", message: unknown.message } },
      ]);
    }
  }),
);
