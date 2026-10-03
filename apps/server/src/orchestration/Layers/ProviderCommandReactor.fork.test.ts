import { it as effectIt } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProviderInstanceId,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { providerErrorLabelFromInstanceHint } from "./ProviderCommandReactor.ts";

describe("fork provider error attribution", () => {
  it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
    expect(
      providerErrorLabelFromInstanceHint({
        instanceId: "third_party_driver",
      }),
    ).toBe("third_party_driver");
  });
});

interface MockCalls {
  readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
}

interface ForkReactorHarness {
  readonly engine: OrchestrationEngineShape;
  readonly startSession: MockCalls;
  readonly sendTurn: MockCalls;
  readonly drain: () => Promise<void>;
  readonly readModel: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly session: { readonly status: string; readonly activeTurnId: string | null } | null;
    }>;
  }>;
  readonly readPendingTurnStarts: () => Promise<ReadonlyArray<{ readonly threadId: string }>>;
}

interface ForkReactorHarnessInput {
  readonly startSessionEffect?: (
    session: ProviderSession,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;
}

// The upstream file passes its reactor harness in, so these cases share its layers.
export function registerProviderCommandReactorForkTests(input: {
  readonly createHarness: (options?: ForkReactorHarnessInput) => Promise<ForkReactorHarness>;
}) {
  effectIt.effect("keeps the turn pending with no active turn while a slow session starts", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const startEntered = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        input.createHarness({
          startSessionEffect: (session) =>
            Deferred.succeed(startEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStart)),
              Effect.as(session),
            ),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider-pending"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("user-message-slow-provider-pending"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* Deferred.await(startEntered);
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      const startingSession = duringStartup.threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      )?.session;
      expect(startingSession?.status).toBe("starting");
      expect(startingSession?.activeTurnId).toBeNull();
      expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([
        { threadId: "thread-1" },
      ]);
      expect(harness.sendTurn.mock.calls).toHaveLength(0);

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => harness.drain());
      expect(harness.sendTurn.mock.calls).toHaveLength(1);
    }),
  );

  effectIt.effect("restarts a Codex session when the main-thread agent changes", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => input.createHarness());
      const now = "2026-01-01T00:00:00.000Z";
      const dispatchTurn = (suffix: string, agent: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-start-agent-${suffix}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make(`user-message-agent-${suffix}`),
            role: "user",
            text: `agent ${suffix}`,
            attachments: [],
          },
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "agent", value: agent },
          ]),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

      yield* dispatchTurn("default", "default");
      yield* Effect.promise(() => harness.drain());
      expect(harness.startSession.mock.calls).toHaveLength(1);
      expect(harness.sendTurn.mock.calls).toHaveLength(1);

      yield* dispatchTurn("fable", "fable");
      yield* Effect.promise(() => harness.drain());
      expect(harness.startSession.mock.calls).toHaveLength(2);
      expect(harness.sendTurn.mock.calls).toHaveLength(2);

      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "agent", value: "fable" },
        ]),
        resumeCursor: { opaque: "resume-1" },
      });
    }),
  );
}
