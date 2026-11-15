import { describe, expect, it } from "vite-plus/test";

import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import {
  ISSUE_NOT_PLANNED_PRESENTATION,
  ISSUE_STATE_PRESENTATION,
  issueStatePresentation,
} from "./issuePresentation";

describe("GitHub issue presentation", () => {
  it("paints an open issue the open pull request's green, reason or none", () => {
    expect(issueStatePresentation("open")).toBe(ISSUE_STATE_PRESENTATION.open);
    expect(issueStatePresentation("open", "completed")).toBe(ISSUE_STATE_PRESENTATION.open);
    expect(issueStatePresentation("open", "not planned")).toBe(ISSUE_STATE_PRESENTATION.open);
  });

  it("keeps a completed issue the merged purple", () => {
    expect(issueStatePresentation("closed", "completed")).toBe(ISSUE_STATE_PRESENTATION.closed);
    expect(ISSUE_STATE_PRESENTATION.closed.toneClassName).toBe(
      PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
    );
  });

  it("drops not planned, and a read that cannot say a reason, to the neutral grey", () => {
    expect(issueStatePresentation("closed", "not planned")).toBe(ISSUE_NOT_PLANNED_PRESENTATION);
    expect(issueStatePresentation("closed", null)).toBe(ISSUE_NOT_PLANNED_PRESENTATION);
    expect(ISSUE_NOT_PLANNED_PRESENTATION.toneClassName).toBe(
      PULL_REQUEST_STATE_PRESENTATION.draft.toneClassName,
    );
  });

  it("never reads a reason-less closed issue as completed, even from an older server", () => {
    expect(issueStatePresentation("closed")).toBe(ISSUE_NOT_PLANNED_PRESENTATION);
    expect(issueStatePresentation("closed", undefined)).toBe(ISSUE_NOT_PLANNED_PRESENTATION);
  });
});
