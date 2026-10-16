import { TEXT_GENERATION_TIMEOUT_MS_FORK, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Covers the whole group request, including OpenCode 1.x's unbounded runner. */
export const withThreadGroupTitleBudgetFork = <A, E, R>(request: Effect.Effect<A, E, R>) =>
  request.pipe(
    Effect.timeoutOrElse({
      duration: TEXT_GENERATION_TIMEOUT_MS_FORK,
      orElse: () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: `The text generation model did not answer within ${TEXT_GENERATION_TIMEOUT_MS_FORK / 1000} seconds.`,
          }),
        ),
    }),
  );
