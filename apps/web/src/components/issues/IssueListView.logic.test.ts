import type { EnvironmentIssueListEntry } from "@t3tools/client-runtime/state/issues";
import { describe, expect, it } from "vite-plus/test";

import {
  applyIssueListView,
  DEFAULT_ISSUE_ORDER,
  issueFacets,
  issueFilterOperatorLabel,
  NO_ISSUE_NARROWING,
  setIssueFilter,
  toggleIssueNarrowing,
  type IssueFilter,
  type IssueOrder,
} from "./IssueListView.logic";

function entry(
  number: number,
  updatedAt: string,
  issueType: string | null,
  labels: ReadonlyArray<string>,
  activity: { comments?: number; positive?: number; negative?: number } = {},
) {
  return {
    environmentId: "environment-1",
    projectId: "project-1",
    projectTitle: "t3code",
    repository: "owner/one",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/one/issues/${number}`,
    author: null,
    assignees: [],
    labels: labels.map((name) => ({ name, color: null })),
    issueType: issueType === null ? null : { name: issueType, color: null },
    state: "open",
    createdAt: updatedAt,
    updatedAt,
    commentCount: activity.comments,
    reactions:
      activity.positive === undefined && activity.negative === undefined
        ? undefined
        : { positive: activity.positive ?? 0, negative: activity.negative ?? 0 },
  } as unknown as EnvironmentIssueListEntry;
}

const entries = [
  entry(9, "2026-08-24T00:00:00Z", "Bug 🐛", ["ui"], { comments: 2, positive: 1, negative: 4 }),
  entry(11, "2026-08-22T00:00:00Z", "Feature ✨", ["ui", "dx"], {
    comments: 7,
    positive: 9,
    negative: 0,
  }),
  entry(4, "2026-08-20T00:00:00Z", null, []),
];

const order = (sort: IssueOrder["sort"], direction: IssueOrder["direction"]) => ({
  sort,
  direction,
});

const is = (field: IssueFilter["field"], ...values: string[]): IssueFilter => ({
  field,
  operator: "is",
  values,
});
const isNot = (field: IssueFilter["field"], ...values: string[]): IssueFilter => ({
  field,
  operator: "is-not",
  values,
});

const numbers = (narrowing: ReadonlyArray<IssueFilter>) =>
  applyIssueListView(entries, narrowing, DEFAULT_ISSUE_ORDER).map((issue) => issue.number);

describe("GitHub issue list view", () => {
  it("offers only the types and labels the fetched list holds, sorted and keeping their colour", () => {
    expect(issueFacets(entries)).toStrictEqual({
      types: [
        { name: "Bug 🐛", color: null },
        { name: "Feature ✨", color: null },
      ],
      labels: [
        { name: "dx", color: null },
        { name: "ui", color: null },
      ],
    });
  });

  it("leaves the merged order untouched when nothing is narrowed or reordered", () => {
    expect(applyIssueListView(entries, NO_ISSUE_NARROWING, DEFAULT_ISSUE_ORDER)).toBe(entries);
  });

  it.each([
    { numbers: [4, 11, 9], sorted: order("updated", "asc") },
    { numbers: [9, 11, 4], sorted: order("created", "desc") },
    { numbers: [11, 9, 4], sorted: order("comments", "desc") },
    { numbers: [4, 9, 11], sorted: order("comments", "asc") },
    { numbers: [11, 9, 4], sorted: order("reactions-positive", "desc") },
    { numbers: [9, 11, 4], sorted: order("reactions-negative", "desc") },
  ])("orders by $sorted.sort $sorted.direction", ({ sorted, numbers }) => {
    const ordered = applyIssueListView(entries, NO_ISSUE_NARROWING, sorted);
    expect(ordered.map((issue) => issue.number)).toStrictEqual(numbers);
  });

  it("sorts an environment that sent no counts last, and breaks ties on issue number", () => {
    const ordered = applyIssueListView(
      [entry(20, "2026-08-24T00:00:00Z", null, []), entry(5, "2026-08-23T00:00:00Z", null, [])],
      NO_ISSUE_NARROWING,
      order("comments", "desc"),
    );
    expect(ordered.map((issue) => issue.number)).toStrictEqual([20, 5]);
  });

  it("narrows to a type, and drops an issue that carries none", () => {
    expect(numbers([is("type", "Bug 🐛")])).toStrictEqual([9]);
  });

  it("treats several labels as an or, and combines them with the type as an and", () => {
    expect(numbers([is("label", "dx", "ui")])).toStrictEqual([9, 11]);
    expect(numbers([is("type", "Feature ✨"), is("label", "dx")])).toStrictEqual([11]);
  });

  it("reads `is not` as the complement, keeping an issue that carries none of the values", () => {
    expect(numbers([isNot("label", "dx")])).toStrictEqual([9, 4]);
    expect(numbers([isNot("type", "Bug 🐛", "Feature ✨")])).toStrictEqual([4]);
  });

  it("adds a name that is absent and removes one that is present, dropping an emptied row", () => {
    const added = toggleIssueNarrowing(NO_ISSUE_NARROWING, "label", "ui");
    expect(added).toStrictEqual([is("label", "ui")]);
    expect(toggleIssueNarrowing(added, "label", "dx")).toStrictEqual([is("label", "ui", "dx")]);
    expect(toggleIssueNarrowing(added, "label", "ui")).toStrictEqual([]);
  });

  it("keeps one row per field, in place, and lets the operator flip without losing the values", () => {
    const narrowing = [is("type", "Bug 🐛"), is("label", "ui")];
    expect(setIssueFilter(narrowing, isNot("type", "Bug 🐛"))).toStrictEqual([
      isNot("type", "Bug 🐛"),
      is("label", "ui"),
    ]);
    expect(setIssueFilter(narrowing, is("type"))).toStrictEqual([is("label", "ui")]);
  });

  it("reads the operator as a sentence that agrees with how many values it holds", () => {
    expect(issueFilterOperatorLabel("is", 1)).toBe("is");
    expect(issueFilterOperatorLabel("is", 2)).toBe("is any of");
    expect(issueFilterOperatorLabel("is-not", 1)).toBe("is not");
    expect(issueFilterOperatorLabel("is-not", 3)).toBe("is not any of");
  });
});
