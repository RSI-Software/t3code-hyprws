import { describe, expect, it } from "vite-plus/test";

import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import {
  GITHUB_ISSUE_NOT_PLANNED_PRESENTATION,
  GITHUB_ISSUE_STATE_PRESENTATION,
  githubIssueStatePresentation,
} from "./githubIssuePresentation";

describe("GitHub issue presentation", () => {
  it("paints an open issue the open pull request's green, reason or none", () => {
    expect(githubIssueStatePresentation("open")).toBe(GITHUB_ISSUE_STATE_PRESENTATION.open);
    expect(githubIssueStatePresentation("open", "completed")).toBe(
      GITHUB_ISSUE_STATE_PRESENTATION.open,
    );
    expect(githubIssueStatePresentation("open", "not planned")).toBe(
      GITHUB_ISSUE_STATE_PRESENTATION.open,
    );
  });

  it("keeps a completed issue the merged purple", () => {
    expect(githubIssueStatePresentation("closed", "completed")).toBe(
      GITHUB_ISSUE_STATE_PRESENTATION.closed,
    );
    expect(GITHUB_ISSUE_STATE_PRESENTATION.closed.toneClassName).toBe(
      PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
    );
  });

  it("drops not planned, and a read that says no reason, to the neutral grey", () => {
    expect(githubIssueStatePresentation("closed", "not planned")).toBe(
      GITHUB_ISSUE_NOT_PLANNED_PRESENTATION,
    );
    expect(githubIssueStatePresentation("closed", null)).toBe(
      GITHUB_ISSUE_NOT_PLANNED_PRESENTATION,
    );
    expect(GITHUB_ISSUE_NOT_PLANNED_PRESENTATION.toneClassName).toBe(
      PULL_REQUEST_STATE_PRESENTATION.draft.toneClassName,
    );
  });

  it("keeps a read that cannot carry a reason at all on the completed tone", () => {
    expect(githubIssueStatePresentation("closed")).toBe(GITHUB_ISSUE_STATE_PRESENTATION.closed);
    expect(githubIssueStatePresentation("closed", undefined)).toBe(
      GITHUB_ISSUE_STATE_PRESENTATION.closed,
    );
  });
});
