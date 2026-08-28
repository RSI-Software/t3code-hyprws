import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { generateThreadGroupTitle } from "./ThreadGroupTitles.ts";

const modelSelection = ModelSelection.make({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6",
});
const memberTitles = ["Manual thread ordering", "Visual session groups"];
const membersAsRequests = "USER:\nManual thread ordering\n\nUSER:\nVisual session groups";

describe("generateThreadGroupTitle", () => {
  it.effect("regenerates from the members and prior title, with no naming request", () =>
    Effect.gen(function* () {
      const generateThreadTitle = vi.fn(() => Effect.succeed({ title: "Sidebar organization" }));

      const result = yield* generateThreadGroupTitle(
        { generateThreadTitle } as unknown as TextGeneration["Service"],
        { cwd: "/repo", memberTitles, previousTitle: "Related work", modelSelection },
      );

      expect(result).toEqual({ title: "Sidebar organization" });
      expect(generateThreadTitle).toHaveBeenCalledWith({
        cwd: "/repo",
        message: membersAsRequests,
        previousTitle: "Related work",
        modelSelection,
      });
    }),
  );

  it.effect("titles a new group from the members alone", () =>
    Effect.gen(function* () {
      const generateThreadTitle = vi.fn(() => Effect.succeed({ title: "Sidebar organization" }));

      yield* generateThreadGroupTitle(
        { generateThreadTitle } as unknown as TextGeneration["Service"],
        { cwd: "/repo", memberTitles, modelSelection },
      );

      expect(generateThreadTitle).toHaveBeenCalledWith({
        cwd: "/repo",
        message: membersAsRequests,
        modelSelection,
      });
    }),
  );
});
