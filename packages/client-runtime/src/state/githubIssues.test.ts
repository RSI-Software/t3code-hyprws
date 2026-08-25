import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, GitHubIssueListResult, ProjectId } from "@t3tools/contracts";

import {
  environmentGitHubIssueKey,
  mergeGitHubIssueLists,
  type EnvironmentGitHubIssueRef,
} from "./githubIssues.ts";

const environmentA = "environment-a" as EnvironmentId;
const environmentB = "environment-b" as EnvironmentId;
const projectId = "project-1" as ProjectId;

function result(updatedAt: string): GitHubIssueListResult {
  return {
    entries: [
      {
        projectId,
        projectTitle: "web",
        repository: "acme/web",
        number: 42,
        title: "Fix it",
        url: "https://github.com/acme/web/issues/42",
        author: null,
        assignees: [],
        labels: [],
        issueType: null,
        state: "open",
        createdAt: "2026-08-20T00:00:00Z",
        updatedAt,
      },
    ],
    errors: [],
    truncated: false,
  };
}

describe("GitHub issue environment merge", () => {
  it("keeps duplicate repository numbers distinct across environments", () => {
    const merged = mergeGitHubIssueLists([
      [environmentA, result("2026-08-21T00:00:00Z")],
      [environmentB, result("2026-08-21T00:00:00Z")],
    ]);
    expect(merged.entries).toHaveLength(2);
    expect(
      new Set(
        merged.entries.map((entry) =>
          environmentGitHubIssueKey(entry satisfies EnvironmentGitHubIssueRef),
        ),
      ).size,
    ).toBe(2);
  });

  it("sorts across environments by timestamp instant", () => {
    const merged = mergeGitHubIssueLists([
      [environmentA, result("2026-08-21T03:30:00+02:00")],
      [environmentB, result("2026-08-21T02:00:00Z")],
    ]);
    expect(merged.entries[0]?.environmentId).toBe(environmentB);
  });

  it("preserves successful answers beside environment transport failures", () => {
    const merged = mergeGitHubIssueLists(
      [[environmentA, result("2026-08-21T00:00:00Z")]],
      [{ environmentId: environmentB, message: "Disconnected" }],
    );
    expect(merged.entries).toHaveLength(1);
    expect(merged.environmentErrors).toStrictEqual([
      { environmentId: environmentB, message: "Disconnected" },
    ]);
  });
});
