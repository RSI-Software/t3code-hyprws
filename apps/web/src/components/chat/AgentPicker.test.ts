import { describe, expect, it } from "vite-plus/test";

import { truncateAgentDescription } from "./AgentPicker";

describe("truncateAgentDescription", () => {
  it("keeps only the first sentence", () => {
    expect(truncateAgentDescription("Plans the work. This extra detail should be hidden.")).toBe(
      "Plans the work.",
    );
  });

  it("caps a long first sentence", () => {
    const preview = truncateAgentDescription(
      `Coordinates ${"complex work ".repeat(20)}without stopping.`,
    );

    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toContain("without stopping");
  });

  it("normalizes whitespace and preserves short descriptions without punctuation", () => {
    expect(truncateAgentDescription("  Short\n\tdescription  ")).toBe("Short description");
  });
});
