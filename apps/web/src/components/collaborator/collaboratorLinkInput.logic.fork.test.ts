import { describe, expect, it } from "vite-plus/test";

import { collaboratorLinkInputFork } from "./collaboratorLinkInput.logic.fork";

const LINK = "http://host.test:8534/pair?thread=mcp%3Aabc#token=K7M2Q9R4T6WX";

describe("collaborator link input", () => {
  it("opens once while the link is typed a character at a time", () => {
    const kinds = [...LINK].map((_, end) => collaboratorLinkInputFork(LINK.slice(0, end + 1)).kind);
    expect(kinds.filter((kind) => kind === "whole")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("whole");
    // From the thread parameter on, the field keeps the link as typed instead of splitting it.
    expect(kinds.slice(kinds.indexOf("partial")).every((kind) => kind !== "other")).toBe(true);
  });

  it("takes a colleague invite with no thread", () => {
    expect(
      collaboratorLinkInputFork("http://host.test:8534/pair?colleague=abc#token=K7M2Q9R4T6WX").kind,
    ).toBe("whole");
  });

  it("leaves a plain pairing link to the upstream field", () => {
    expect(collaboratorLinkInputFork("http://host.test:8534/pair#token=K7M2Q9R4T6WX").kind).toBe(
      "other",
    );
  });
});
