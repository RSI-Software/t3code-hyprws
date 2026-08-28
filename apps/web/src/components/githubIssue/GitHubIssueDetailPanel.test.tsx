import type { GitHubSubIssue } from "@t3tools/contracts";
import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId, type ComposerThreadDraftState } from "../../composerDraftStore";

import {
  GitHubSubIssueRow,
  githubIssueHandoffPrompt,
  seedGitHubIssueDraftIfEmpty,
} from "./GitHubIssueDetailPanel";

const child: GitHubSubIssue = {
  number: 42,
  title: "Keep the parent tab",
  state: "open",
  url: "https://github.com/acme/web/issues/42",
};

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

  it("fills every supported field in a custom template", () => {
    expect(
      githubIssueHandoffPrompt(
        {
          number: 42,
          title: "Fix the cache",
          url: "https://github.com/acme/web/issues/42",
        },
        "Issue {{number}}: {{title}}\nSource: {{url}}\nAgain: {{number}}",
      ),
    ).toBe("Issue 42: Fix the cache\nSource: https://github.com/acme/web/issues/42\nAgain: 42");
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

describe("GitHub sub-issue row", () => {
  it("keeps in-app navigation separate from the GitHub link", () => {
    const onSelect = vi.fn();
    const row = GitHubSubIssueRow({ child, repository: "acme/web", onSelect });
    expect(isValidElement(row)).toBe(true);

    const [button, externalLink] = Children.toArray(
      (row as ReactElement<{ children: ReactElement[] }>).props.children,
    );
    expect(isValidElement(button)).toBe(true);
    expect((button as ReactElement).type).toBe("button");
    (button as ReactElement<{ onClick: () => void }>).props.onClick();
    expect(onSelect).toHaveBeenCalledWith(child);

    expect(isValidElement(externalLink)).toBe(true);
    expect((externalLink as ReactElement<{ "aria-label": string }>).props["aria-label"]).toBe(
      "Open issue #42 on GitHub",
    );
  });

  it("opens a foreign-repository child directly on GitHub", () => {
    const row = GitHubSubIssueRow({ child, repository: "acme/api", onSelect: vi.fn() });
    expect(isValidElement(row)).toBe(true);
    expect((row as ReactElement).type).toBe("a");
    expect((row as ReactElement<{ href: string }>).props.href).toBe(child.url);
  });
});
