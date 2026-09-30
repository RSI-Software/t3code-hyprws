import { describe, expect, it } from "vite-plus/test";

import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions (fork)", () => {
  it("asks agents to link the GitHub issues they work on, beside the pull request line", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_issue");
    expect(instructions).toContain("call list_thread_issues to check");
    expect(instructions.indexOf("link_issue")).toBeGreaterThan(
      instructions.indexOf("link_pull_request"),
    );
    expect(instructions.indexOf("link_issue")).toBeLessThan(
      instructions.indexOf("</pull_request_linking>"),
    );
  });
});
