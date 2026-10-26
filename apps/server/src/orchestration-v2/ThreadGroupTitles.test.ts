import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { generateThreadGroupTitle, THREAD_GROUP_TITLE_INSTRUCTIONS } from "./ThreadGroupTitles.ts";

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
        instructions: THREAD_GROUP_TITLE_INSTRUCTIONS,
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
        instructions: THREAD_GROUP_TITLE_INSTRUCTIONS,
        modelSelection,
      });
    }),
  );

  it.effect("leads with the parent, marked, so the newest member does not decide", () =>
    Effect.gen(function* () {
      const generateThreadTitle = vi.fn(() => Effect.succeed({ title: "Stale issue triage" }));

      yield* generateThreadGroupTitle(
        { generateThreadTitle } as unknown as TextGeneration["Service"],
        {
          cwd: "/repo",
          memberTitles: ["Fix file save conflict", "Fix Connections controls"],
          parentTitle: "Triage stale issues",
          previousTitle: "Fix Connections controls",
          modelSelection,
        },
      );

      expect(generateThreadTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "USER (parent thread):\nTriage stale issues\n\nUSER:\nFix file save conflict\n\nUSER:\nFix Connections controls",
          instructions: expect.stringContaining("anchored on the parent thread"),
        }),
      );
    }),
  );
});
