import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  EnvironmentGitHubIssueListEntry,
  MergedGitHubIssueList,
} from "@t3tools/client-runtime/state/github-issues";
import { describe, expect, it } from "vite-plus/test";

import {
  gitHubIssueListReadFailed,
  holdGitHubIssueList,
  keepGitHubIssueListRows,
} from "./githubIssueListKeep.logic";

function entry(number: number, title: string): EnvironmentGitHubIssueListEntry {
  return {
    environmentId: "env",
    projectId: "project",
    projectTitle: "Project",
    repository: "acme/app",
    number,
    title,
    url: `https://github.com/acme/app/issues/${number}`,
    author: { login: "octo" },
    assignees: [],
    labels: [],
    state: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as EnvironmentGitHubIssueListEntry;
}

const goodList: MergedGitHubIssueList = {
  entries: [entry(1, "Fork fold absorbs repairs"), entry(2, "Sync blocked on nightly")],
  errors: [],
  environmentErrors: [],
  truncated: true,
};

const allFailed: MergedGitHubIssueList = {
  entries: [],
  errors: [
    {
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      projectTitle: "Project",
      message: "acme/app could not be read: gh: auth failed",
    },
  ],
  environmentErrors: [],
  truncated: false,
};

describe("gitHubIssueListReadFailed", () => {
  it("reads a no-rows answer that carries project errors as a failure", () => {
    expect(gitHubIssueListReadFailed(allFailed)).toBe(true);
  });

  it("leaves a good list alone", () => {
    expect(gitHubIssueListReadFailed(goodList)).toBe(false);
  });

  it("leaves an environment-level failure alone, which the failed-read path already keeps", () => {
    expect(
      gitHubIssueListReadFailed({
        ...goodList,
        entries: [],
        environmentErrors: [
          { environmentId: EnvironmentId.make("env"), message: "The environment did not answer." },
        ],
      }),
    ).toBe(false);
  });
});

describe("keepGitHubIssueListRows", () => {
  it("keeps the held rows under the failed answer's current errors", () => {
    const kept = keepGitHubIssueListRows(allFailed, goodList);
    expect(kept?.entries.map((issue) => issue.number)).toEqual([1, 2]);
    expect(kept?.errors).toEqual(allFailed.errors);
    expect(kept?.environmentErrors).toEqual([]);
  });

  it("keeps the truncation the held rows were read with", () => {
    expect(keepGitHubIssueListRows(allFailed, goodList)?.truncated).toBe(true);
    expect(keepGitHubIssueListRows(allFailed, { ...goodList, truncated: false })?.truncated).toBe(
      false,
    );
  });

  it("keeps nothing before any rows were read, leaving the failure as the answer", () => {
    expect(keepGitHubIssueListRows(allFailed, null)).toBeNull();
    expect(keepGitHubIssueListRows(allFailed, { ...goodList, entries: [] })).toBeNull();
  });
});

describe("holdGitHubIssueList", () => {
  const scope = `[{"environmentId":"env","input":{"projectId":"p"}}]`;

  it("keeps the held answer when the read failed for every project in a held scope", () => {
    const store = new Map([[scope, goodList]]);
    holdGitHubIssueList(store, allFailed, scope);
    expect(store.get(scope)).toBe(goodList);
    expect(store.size).toBe(1);
  });

  it("stores a read that answered, and a failure before anything is held", () => {
    const store = new Map<string, MergedGitHubIssueList>();
    holdGitHubIssueList(store, goodList, scope);
    expect(store.get(scope)).toBe(goodList);
    const empty = new Map<string, MergedGitHubIssueList>();
    holdGitHubIssueList(empty, allFailed, scope);
    expect(empty.get(scope)).toBe(allFailed);
  });

  it("stores a failure for a scope nothing is held for, leaving other scopes alone", () => {
    const store = new Map([["other", goodList]]);
    holdGitHubIssueList(store, allFailed, scope);
    expect(store.get(scope)).toBe(allFailed);
    expect(store.get("other")).toBe(goodList);
  });

  it("writes nothing when the answer is the one already held, so a re-render stays idle", () => {
    const store = new Map<string, MergedGitHubIssueList>([[scope, allFailed]]);
    holdGitHubIssueList(store, allFailed, scope);
    expect(store.get(scope)).toBe(allFailed);
  });
});
