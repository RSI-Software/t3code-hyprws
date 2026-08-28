import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { generateThreadGroupTitle } from "./ThreadGroupTitles.ts";

describe("generateThreadGroupTitle", () => {
  it.effect("uses thread-title regeneration with the group members and prior title", () =>
    Effect.gen(function* () {
      const generateThreadTitle = vi.fn(() => Effect.succeed({ title: "Sidebar organization" }));
      const modelSelection = ModelSelection.make({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      });

      const result = yield* generateThreadGroupTitle(
        { generateThreadTitle } as unknown as TextGeneration["Service"],
        {
          cwd: "/repo",
          memberTitles: ["Manual thread ordering", "Visual session groups"],
          previousTitle: "Related work",
          modelSelection,
        },
      );

      expect(result).toEqual({ title: "Sidebar organization" });
      expect(generateThreadTitle).toHaveBeenCalledWith({
        cwd: "/repo",
        message:
          "Name a visual sidebar group containing these related T3 Code threads:\n- Manual thread ordering\n- Visual session groups",
        previousTitle: "Related work",
        modelSelection,
      });
    }),
  );
});
