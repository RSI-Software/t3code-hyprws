import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  EnvironmentIssueListEntry,
  MergedIssueList,
} from "@t3tools/client-runtime/state/issues";
import { describe, expect, it } from "vite-plus/test";

import { issueListReadFailed, holdIssueList, keepIssueListRows } from "./issueListKeep.logic";

function entry(number: number, title: string): EnvironmentIssueListEntry {
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
  } as unknown as EnvironmentIssueListEntry;
}

const goodList: MergedIssueList = {
  entries: [entry(1, "Fork fold absorbs repairs"), entry(2, "Sync blocked on nightly")],
  errors: [],
  environmentErrors: [],
  truncated: true,
};

const allFailed: MergedIssueList = {
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

describe("issueListReadFailed", () => {
  it("reads a no-rows answer that carries project errors as a failure", () => {
    expect(issueListReadFailed(allFailed)).toBe(true);
  });

  it("leaves a good list alone", () => {
    expect(issueListReadFailed(goodList)).toBe(false);
  });

  it("leaves an environment-level failure alone, which the failed-read path already keeps", () => {
    expect(
      issueListReadFailed({
        ...goodList,
        entries: [],
        environmentErrors: [
          { environmentId: EnvironmentId.make("env"), message: "The environment did not answer." },
        ],
      }),
    ).toBe(false);
  });
});

describe("keepIssueListRows", () => {
  it("keeps the held rows under the failed answer's current errors", () => {
    const kept = keepIssueListRows(allFailed, goodList);
    expect(kept?.entries.map((issue) => issue.number)).toEqual([1, 2]);
    expect(kept?.errors).toEqual(allFailed.errors);
    expect(kept?.environmentErrors).toEqual([]);
  });

  it("keeps the truncation the held rows were read with", () => {
    expect(keepIssueListRows(allFailed, goodList)?.truncated).toBe(true);
    expect(keepIssueListRows(allFailed, { ...goodList, truncated: false })?.truncated).toBe(false);
  });

  it("keeps nothing before any rows were read, leaving the failure as the answer", () => {
    expect(keepIssueListRows(allFailed, null)).toBeNull();
    expect(keepIssueListRows(allFailed, { ...goodList, entries: [] })).toBeNull();
  });
});

describe("holdIssueList", () => {
  const scope = `[{"environmentId":"env","input":{"projectId":"p"}}]`;

  it("keeps the held answer when the read failed for every project in a held scope", () => {
    const store = new Map([[scope, goodList]]);
    holdIssueList(store, allFailed, scope);
    expect(store.get(scope)).toBe(goodList);
    expect(store.size).toBe(1);
  });

  it("stores a read that answered, and a failure before anything is held", () => {
    const store = new Map<string, MergedIssueList>();
    holdIssueList(store, goodList, scope);
    expect(store.get(scope)).toBe(goodList);
    const empty = new Map<string, MergedIssueList>();
    holdIssueList(empty, allFailed, scope);
    expect(empty.get(scope)).toBe(allFailed);
  });

  it("stores a failure for a scope nothing is held for, leaving other scopes alone", () => {
    const store = new Map([["other", goodList]]);
    holdIssueList(store, allFailed, scope);
    expect(store.get(scope)).toBe(allFailed);
    expect(store.get("other")).toBe(goodList);
  });

  it("writes nothing when the answer is the one already held, so a re-render stays idle", () => {
    const store = new Map<string, MergedIssueList>([[scope, allFailed]]);
    holdIssueList(store, allFailed, scope);
    expect(store.get(scope)).toBe(allFailed);
  });
});
