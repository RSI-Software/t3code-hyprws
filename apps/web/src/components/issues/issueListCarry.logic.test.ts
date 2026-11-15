import type { EnvironmentIssueListEntry } from "@t3tools/client-runtime/state/issues";
import { describe, expect, it } from "vite-plus/test";

import { carryIssueList, issueListScope } from "./issueListCarry.logic";

function entry(
  number: number,
  title: string,
  state: "open" | "closed",
  labels: ReadonlyArray<string> = [],
): EnvironmentIssueListEntry {
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
    labels: labels.map((name) => ({ name, color: "ededed" })),
    state,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as EnvironmentIssueListEntry;
}

const held = {
  entries: [
    entry(1, "Fork fold absorbs repairs", "open", ["dx"]),
    entry(2, "Sync blocked on nightly", "open", ["ci"]),
    entry(3, "Fork tooling sheds flags", "closed"),
  ],
  errors: [],
  environmentErrors: [],
  truncated: true,
};

const numbers = (list: ReturnType<typeof carryIssueList>) =>
  list?.entries.map((issue) => issue.number) ?? null;

describe("carryIssueList", () => {
  it("narrows held rows by every free-text term across title, number and labels", () => {
    expect(numbers(carryIssueList(held, { state: "all", query: "fork" }))).toEqual([1, 3]);
    expect(numbers(carryIssueList(held, { state: "all", query: "fork dx" }))).toEqual([1]);
    expect(numbers(carryIssueList(held, { state: "all", query: "#2" }))).toEqual([2]);
  });

  it("narrows by state, and leaves qualifiers to GitHub", () => {
    expect(numbers(carryIssueList(held, { state: "closed" }))).toEqual([3]);
    expect(numbers(carryIssueList(held, { state: "open", query: "label:bug" }))).toEqual([1, 2]);
  });

  it("carries nothing rather than an empty list GitHub has not confirmed", () => {
    expect(carryIssueList(held, { state: "open", query: "nothing matches" })).toBeNull();
  });

  it("drops the held answer's errors and truncation, which describe another question", () => {
    const carried = carryIssueList(held, { state: "all" });
    expect(carried?.truncated).toBe(false);
    expect(carried?.errors).toEqual([]);
  });
});

describe("issueListScope", () => {
  it("ignores state and search, but not which projects are asked", () => {
    const open = [{ environmentId: "env", input: { state: "open" as const, projectId: "p" } }];
    const closed = [
      { environmentId: "env", input: { state: "closed" as const, projectId: "p", query: "x" } },
    ];
    const other = [{ environmentId: "env", input: { state: "open" as const, projectId: "q" } }];
    expect(issueListScope(open as never)).toBe(issueListScope(closed as never));
    expect(issueListScope(open as never)).not.toBe(issueListScope(other as never));
  });
});
