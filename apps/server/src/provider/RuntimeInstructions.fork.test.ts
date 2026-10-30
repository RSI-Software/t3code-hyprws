import { describe, expect, it } from "vite-plus/test";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

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

  it("asks agents to link documents they keep updating, after the issue line", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("call link_artifact once after creating it");
    expect(instructions.indexOf("link_artifact")).toBeGreaterThan(
      instructions.indexOf("list_thread_issues"),
    );
    expect(instructions.indexOf("link_artifact")).toBeLessThan(
      instructions.indexOf("</pull_request_linking>"),
    );
  });
});
