import { DraftId, type ComposerThreadDraftState } from "../../composerDraftStore";
import { describe, expect, it, vi } from "vite-plus/test";

import { githubIssueHandoffPrompt, seedGitHubIssueDraftIfEmpty } from "./GitHubIssueDetailPanel";

const emptyDraft: ComposerThreadDraftState = {
  prompt: "",
  images: [],
  nonPersistedImageIds: [],
  persistedAttachments: [],
  terminalContexts: [],
  elementContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  modelSelectionByProvider: {},
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
};

describe("GitHub issue handoff", () => {
  it("builds a bounded prompt without body or comments", () => {
    const prompt = githubIssueHandoffPrompt({
      number: 42,
      title: "Fix the cache",
      url: "https://github.com/acme/web/issues/42",
    });
    expect(prompt).toContain("Work on GitHub issue #42: Fix the cache");
    expect(prompt).toContain("https://github.com/acme/web/issues/42");
    expect(prompt).not.toContain("issue body");
    expect(prompt.split("\n")).toHaveLength(3);
  });

  it("seeds only an empty destination composer", () => {
    const setPrompt = vi.fn();
    expect(
      seedGitHubIssueDraftIfEmpty(DraftId.make("draft-1"), "task", {
        getComposerDraft: () => emptyDraft,
        setPrompt,
      }),
    ).toBe(true);
    expect(setPrompt).toHaveBeenCalledOnce();

    setPrompt.mockClear();
    expect(
      seedGitHubIssueDraftIfEmpty(DraftId.make("draft-1"), "task", {
        getComposerDraft: () => ({ ...emptyDraft, prompt: "invested draft" }),
        setPrompt,
      }),
    ).toBe(false);
    expect(setPrompt).not.toHaveBeenCalled();
  });
});
