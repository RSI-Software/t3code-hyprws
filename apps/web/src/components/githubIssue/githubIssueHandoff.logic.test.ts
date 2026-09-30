import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createGitHubIssueHandoffStore,
  takeGitHubIssueHandoffLinks,
} from "./githubIssueHandoff.logic";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const issue = (number: number) => ({
  host: "github.com",
  repository: "acme/app",
  number,
  url: `https://github.com/acme/app/issues/${number}`,
});

const thread = (threadId: string, environmentId = "env") =>
  ({ environmentId, threadId }) as unknown as ScopedThreadRef;

describe("takeGitHubIssueHandoffLinks", () => {
  const take = (
    store: ReturnType<typeof createGitHubIssueHandoffStore>,
    draftId: string | null,
    threadRefs: ReadonlyArray<ScopedThreadRef>,
    supported: ReadonlyArray<string> = ["env"],
  ) =>
    takeGitHubIssueHandoffLinks({
      store,
      draftId,
      threadRefs,
      supportsThreadIssues: (environmentId) => supported.includes(environmentId),
    });

  it("links the draft's issue as a handoff at the first send, once", () => {
    const store = createGitHubIssueHandoffStore(memoryStorage());
    store.record("draft", issue(7));
    expect(take(store, "draft", [thread("t1")])).toEqual([
      {
        environmentId: "env",
        input: { threadId: "t1", ...issue(7), source: "handoff" },
      },
    ]);
    expect(take(store, "draft", [thread("t1")])).toEqual([]);
  });

  it("keeps the issue through a failed send so the retry on a re-minted thread links it", () => {
    const store = createGitHubIssueHandoffStore(memoryStorage());
    store.record("draft", issue(7));
    // A failed send starts no thread, so nothing is taken.
    expect(take(store, "draft", [])).toEqual([]);
    expect(take(store, "draft", [thread("retried")]).map((link) => link.input.threadId)).toEqual([
      "retried",
    ]);
    expect(take(store, "draft", [thread("retried")])).toEqual([]);
  });

  it("survives a reload and a reused draft, where the latest issue wins", () => {
    const storage = memoryStorage();
    createGitHubIssueHandoffStore(storage).record("draft", issue(7));
    createGitHubIssueHandoffStore(storage).record("draft", issue(8));
    const reloaded = createGitHubIssueHandoffStore(storage);
    expect(take(reloaded, "draft", [thread("t1")]).map((link) => link.input.number)).toEqual([8]);
  });

  it("links every thread a multi-model send started and skips environments without links", () => {
    const store = createGitHubIssueHandoffStore(memoryStorage());
    store.record("draft", issue(7));
    const links = take(store, "draft", [thread("a"), thread("b"), thread("c", "old")]);
    expect(links.map((link) => link.input.threadId)).toEqual(["a", "b"]);
    expect(take(store, "draft", [thread("a")])).toEqual([]);
  });

  it("links nothing for a draft that never handed an issue off", () => {
    const store = createGitHubIssueHandoffStore(memoryStorage());
    store.record("other", issue(7));
    expect(take(store, "draft", [thread("t1")])).toEqual([]);
    expect(take(store, null, [thread("t1")])).toEqual([]);
  });

  it("ignores a corrupt persisted entry", () => {
    const storage = memoryStorage();
    storage.setItem("t3code:github-issue-handoffs:v1", JSON.stringify({ draft: { number: 7 } }));
    expect(take(createGitHubIssueHandoffStore(storage), "draft", [thread("t1")])).toEqual([]);
  });
});
