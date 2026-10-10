import { describe, expect, it, vi } from "vite-plus/test";
import { searchSettings } from "./settingsSearch";

vi.mock("~/env", () => ({ isElectron: false }));

describe("browser dictation settings search", () => {
  it.each(["dictation", "cleanup", "formatting", "project context", "prompt model"])(
    "finds Dictation for %s in a browser",
    (query) => {
      expect(searchSettings(query)).toContainEqual(
        expect.objectContaining({
          id: "voice-input-fork",
          to: "/settings/dictation",
        }),
      );
    },
  );
});
