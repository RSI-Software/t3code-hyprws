import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, TEXT_GENERATION_TIMEOUT_MS_FORK } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { generateThreadGroupTitle } from "./ThreadGroupTitles.ts";

const unused = () => Effect.die("Unexpected text generation operation");

it.effect("bounds an unbounded group title and names its budget in the failure", () =>
  Effect.gen(function* () {
    let interrupted = false;
    const provider = TextGeneration.of({
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateBranchName: unused,
      generateReviewGuide: unused,
      generateThreadTitle: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
    });
    const pending = yield* generateThreadGroupTitle(provider, {
      cwd: "/repo",
      memberTitles: ["Manual ordering", "Visual groups"],
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "zai/glm-5.3-flash",
      },
    }).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(TEXT_GENERATION_TIMEOUT_MS_FORK - 1);
    expect(interrupted).toBe(false);
    yield* TestClock.adjust(1);
    expect(yield* Fiber.join(pending)).toMatchObject({
      _tag: "TextGenerationError",
      detail: "The text generation model did not answer within 180 seconds.",
    });
    expect(interrupted).toBe(true);
  }),
);
