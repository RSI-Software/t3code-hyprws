import type { DraftId } from "../../composerDraftStore";
import { describe, expect, it } from "vite-plus/test";

import {
  appendGitHubIssuePrompt,
  githubIssueAskPrompt,
  githubIssueExplainPrompt,
} from "./githubIssueAsk.logic";

const issue = { number: 42, title: "Fix the cache", url: "https://github.com/acme/web/issues/42" };

function draftStore(prompt: string | null) {
  const state = { prompt };
  return {
    state,
    store: {
      getComposerDraft: () => (state.prompt === null ? null : { prompt: state.prompt }),
      setPrompt: (_target: unknown, next: string) => {
        state.prompt = next;
      },
    } as unknown as Parameters<typeof appendGitHubIssuePrompt>[2],
  };
}

describe("GitHub issue questions", () => {
  it("names the issue and forbids code changes in both prompts", () => {
    for (const prompt of [githubIssueAskPrompt(issue), githubIssueExplainPrompt(issue)]) {
      expect(prompt).toContain(
        "issue #42, `Fix the cache`, at https://github.com/acme/web/issues/42",
      );
      expect(prompt).toContain("do not change any code");
    }
  });

  it("leaves the question itself for the reader to type", () => {
    expect(githubIssueAskPrompt(issue).endsWith("\n\n")).toBe(true);
  });

  it("goes below what the reader already typed", () => {
    const { state, store } = draftStore("Also check the tests.  ");
    appendGitHubIssuePrompt("draft-1" as DraftId, githubIssueExplainPrompt(issue), store);
    expect(state.prompt).toBe(`Also check the tests.\n\n${githubIssueExplainPrompt(issue)}`);
  });

  it("fills an empty composer and does not stack a repeated press", () => {
    const { state, store } = draftStore(null);
    const prompt = githubIssueAskPrompt(issue);
    appendGitHubIssuePrompt("draft-1" as DraftId, prompt, store);
    appendGitHubIssuePrompt("draft-1" as DraftId, prompt, store);
    expect(state.prompt).toBe(prompt);
  });
});
