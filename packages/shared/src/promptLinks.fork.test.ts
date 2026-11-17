import { describe, expect, it } from "vite-plus/test";

import { parseNewThreadLink } from "./promptLinks.ts";

const repositoryOf = (search: Record<string, string>) => {
  const link = parseNewThreadLink(new URLSearchParams(search).toString());
  return link.ok && link.value.kind === "new" ? link.value.repository : "invalid";
};

describe("parseNewThreadLink with a Linear repo label", () => {
  const prompt = [
    "Work on Linear issue PLAT-1:",
    '<issue identifier="PLAT-1">',
    "<label>Area › dx</label>",
    "<label>repo › RSI-Software/rsi</label>",
    "</issue>",
  ].join("\n");

  it("opens the labelled repository when the link names none", () => {
    expect(repositoryOf({ prompt })).toEqual({ owner: "RSI-Software", name: "rsi" });
  });

  it("keeps the link's own repository and ignores other labels", () => {
    expect(repositoryOf({ prompt, repo: "donjor/bakery" })).toEqual({
      owner: "donjor",
      name: "bakery",
    });
    expect(repositoryOf({ prompt: "<label>Repo › bakery</label>" })).toBeNull();
    expect(repositoryOf({ prompt: "<label>Area › dx</label>" })).toBeNull();
  });
});
