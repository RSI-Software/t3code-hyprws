// @effect-diagnostics globalDate:off - Fixed Date fixtures make Refresh log rows deterministic.

import { assert, it } from "@effect/vitest";

import {
  findIssueTypeId,
  hasPlainSingleSelectOption,
  reconcileRebaseBlock,
  type CreateRebaseIssue,
  type NotifyInput,
  type RebaseGitHubClient,
  type RebaseIssue,
  type RebaseIssueComment,
} from "./fork-rebase-notify.ts";
import { blockedIssueTitle, type BlockedIssue } from "./lib/fork-rebase-issues.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const blocked = (sha: string, tag = "v1.2.0-nightly.20260830.1000"): BlockedIssue => ({
  title: blockedIssueTitle(tag, sha.slice(0, 7)),
  label: "rebase-blocked",
  blockingSha: sha,
  blockingShortSha: sha.slice(0, 7),
  subject: "upstream conflict",
  remainingUpstreamCount: 3,
  newestUpstreamTagBeyondWindow: tag,
  stopCensus: {
    targetTag: tag,
    conflictingForkCommitCount: 2,
    conflictingFileCount: 2,
    truncated: false,
    truncatedBy: null,
    stopLimit: 128,
    timeLimitSeconds: 360,
  },
  stopCensusUnavailableReason: null,
  conflicts: [],
  body: `current report for ${tag}\n\n<!-- blocking-sha:${sha} -->`,
});

const input = (current: BlockedIssue | null): NotifyInput => ({
  mode: "candidate",
  status: "no-op",
  oldSha: "c".repeat(40),
  newSha: null,
  blocked: current,
});

class FakeGitHub implements RebaseGitHubClient {
  readonly issues: Array<RebaseIssue>;
  readonly comments = new Map<number, Array<RebaseIssueComment>>();
  readonly created: Array<CreateRebaseIssue> = [];
  readonly bodyEdits: Array<number> = [];
  readonly commentEdits: Array<number> = [];
  readonly closed: Array<number> = [];
  readonly issueTypeLookups: Array<string> = [];
  readonly issueTypeEdits: Array<number> = [];
  labelsEnsured = 0;
  listCalls = 0;
  issueTypeLookupError: Error | null = null;
  beforeList: ((call: number) => void) | null = null;
  private nextIssue = 1;
  private nextComment = 100;

  constructor(issues: ReadonlyArray<RebaseIssue> = []) {
    this.issues = issues.map((issue) => ({ ...issue }));
    this.nextIssue = Math.max(0, ...issues.map((issue) => issue.number)) + 1;
  }

  ensureBlockedLabel(): void {
    this.labelsEnsured += 1;
  }

  listBlockedIssues(): ReadonlyArray<RebaseIssue> {
    this.listCalls += 1;
    this.beforeList?.(this.listCalls);
    return this.issues.map((issue) => ({ ...issue }));
  }

  listIssueComments(issueNumber: number): ReadonlyArray<RebaseIssueComment> {
    return (this.comments.get(issueNumber) ?? []).map((comment) => ({ ...comment }));
  }

  lookupIssueTypeId(issueType: "Bug"): string {
    this.issueTypeLookups.push(issueType);
    if (this.issueTypeLookupError !== null) throw this.issueTypeLookupError;
    return "bug-type";
  }

  applyIssueType(issue: RebaseIssue, issueTypeId: string): void {
    assert.strictEqual(issueTypeId, "bug-type");
    const stored = this.issues.find((candidate) => candidate.number === issue.number);
    if (stored === undefined) throw new Error("missing fake issue");
    Object.assign(stored, { issueType: "Bug" });
    this.issueTypeEdits.push(issue.number);
  }

  createIssue(issue: CreateRebaseIssue): RebaseIssue {
    this.created.push(issue);
    const number = this.nextIssue++;
    const created = {
      number,
      nodeId: `issue-${number}`,
      state: "open" as const,
      title: issue.title,
      body: issue.body,
      issueType: null,
    };
    this.issues.push(created);
    return created;
  }

  updateIssueBody(issueNumber: number, body: string): void {
    const issue = this.issues.find((candidate) => candidate.number === issueNumber);
    if (issue === undefined) throw new Error("missing fake issue");
    Object.assign(issue, { body });
    this.bodyEdits.push(issueNumber);
  }

  createIssueComment(issueNumber: number, body: string): RebaseIssueComment {
    const comment = { id: this.nextComment++, body };
    this.comments.set(issueNumber, [...(this.comments.get(issueNumber) ?? []), comment]);
    return comment;
  }

  updateIssueComment(commentId: number, body: string): void {
    for (const comments of this.comments.values()) {
      const comment = comments.find((candidate) => candidate.id === commentId);
      if (comment === undefined) continue;
      Object.assign(comment, { body });
      this.commentEdits.push(commentId);
      return;
    }
    throw new Error("missing fake comment");
  }

  closeIssue(issueNumber: number): void {
    const issue = this.issues.find((candidate) => candidate.number === issueNumber);
    if (issue === undefined) throw new Error("missing fake issue");
    Object.assign(issue, { state: "closed" });
    this.closed.push(issueNumber);
  }
}

const openIssues = (client: FakeGitHub): ReadonlyArray<RebaseIssue> =>
  client.issues.filter((issue) => issue.state === "open");

it("creates one assigned block issue and one Refresh log comment", () => {
  const client = new FakeGitHub();
  const report = blocked(SHA_A);
  reconcileRebaseBlock(client, input(report), new Date("2026-08-30T00:13:00Z"));

  assert.strictEqual(client.created.length, 1);
  assert.deepStrictEqual(client.created[0], {
    title: "🔔 hyprws auto-rebase blocked at v1.2.0-nightly.20260830.1000 (upstream aaaaaaa)",
    body: report.body,
    labels: ["rebase-blocked", "ci"],
    assignee: "donjor",
    priority: "High",
  });
  assert.deepStrictEqual(client.issueTypeLookups, ["Bug"]);
  assert.deepStrictEqual(client.issueTypeEdits, [1]);
  assert.strictEqual(openIssues(client).length, 1);
  const comment = client.comments.get(1)?.[0]?.body ?? "";
  assert.strictEqual(
    comment,
    `<!-- hyprws-rebase-refresh-log -->
Refresh log  (1 update)

\`\`\`text
#0 08-30 00:13  hyprws  o--X--o--o--N  v1.2.0-nightly.20260830.1000  2c

block aaaaaaa unchanged since #0
o commit  X block  N nightly tag  S stable tag  Nc = conflicts to that tag
\`\`\`
<!-- hyprws-rebase-refresh-tag:v1.2.0-nightly.20260830.1000 -->`,
  );
});

it("looks up the enabled native Bug type by repository issue-type name", () => {
  assert.strictEqual(
    findIssueTypeId(
      [
        { id: "disabled", name: "Bug", isEnabled: false },
        { id: "bug", name: "Bug 🐛", isEnabled: true },
        { id: "task", name: "Task 🔨", isEnabled: true },
      ],
      "Bug",
    ),
    "bug",
  );
  assert.strictEqual(findIssueTypeId([], "Bug"), null);
});

it("recognizes Priority only as a plain org single-select option", () => {
  assert.strictEqual(
    hasPlainSingleSelectOption(
      [
        {
          __typename: "IssueFieldSingleSelect",
          name: "Priority",
          options: [{ name: "High" }],
        },
      ],
      "Priority",
      "High",
    ),
    true,
  );
  assert.strictEqual(
    hasPlainSingleSelectOption(
      [{ __typename: "ProjectV2SingleSelectField", name: "Priority" }],
      "Priority",
      "High",
    ),
    false,
  );
});

it("aborts before creating when the native Bug type lookup fails", () => {
  const client = new FakeGitHub();
  client.issueTypeLookupError = new Error("repository issue type Bug lookup failed");

  assert.throws(
    () => reconcileRebaseBlock(client, input(blocked(SHA_A))),
    /repository issue type Bug lookup failed/,
  );
  assert.deepStrictEqual(client.created, []);
  assert.deepStrictEqual(client.issueTypeEdits, []);
});

it("applies a missing native Bug type when refreshing an open block issue", () => {
  const report = blocked(SHA_A);
  const client = new FakeGitHub([
    {
      number: 7,
      nodeId: "issue-7",
      state: "open",
      title: report.title,
      body: report.body,
      issueType: null,
    },
  ]);

  reconcileRebaseBlock(client, input(report), new Date("2026-08-30T00:13:00Z"));

  assert.deepStrictEqual(client.issueTypeLookups, ["Bug"]);
  assert.deepStrictEqual(client.issueTypeEdits, [7]);
  assert.strictEqual(client.issues[0]?.issueType, "Bug");
  assert.strictEqual(client.created.length, 0);
});

it("does not look up or apply the native Bug type when refresh already has one", () => {
  const report = blocked(SHA_A);
  const client = new FakeGitHub([
    {
      number: 7,
      nodeId: "issue-7",
      state: "open",
      title: report.title,
      body: report.body,
      issueType: "Bug",
    },
  ]);

  reconcileRebaseBlock(client, input(report), new Date("2026-08-30T00:13:00Z"));

  assert.deepStrictEqual(client.issueTypeLookups, []);
  assert.deepStrictEqual(client.issueTypeEdits, []);
});

it("rewrites the body but leaves the Refresh log unchanged for the same tag", () => {
  const client = new FakeGitHub();
  const report = blocked(SHA_A);
  reconcileRebaseBlock(client, input(report), new Date("2026-08-30T00:13:00Z"));
  const before = client.comments.get(1)?.[0]?.body;

  reconcileRebaseBlock(
    client,
    input({ ...report, body: `${report.body}\nrefreshed` }),
    new Date("2026-08-30T06:17:00Z"),
  );

  assert.deepStrictEqual(client.bodyEdits, [1]);
  assert.strictEqual(client.comments.get(1)?.[0]?.body, before);
  assert.deepStrictEqual(client.commentEdits, []);
  assert.strictEqual(client.created.length, 1);
});

it("appends one row when the newest tag moves without retitling", () => {
  const client = new FakeGitHub();
  reconcileRebaseBlock(client, input(blocked(SHA_A)), new Date("2026-08-30T00:13:00Z"));
  const originalTitle = client.issues[0]?.title;
  const moved = blocked(SHA_A, "v1.2.0");

  reconcileRebaseBlock(client, input(moved), new Date("2026-08-30T06:17:00Z"));

  const comment = client.comments.get(1)?.[0]?.body ?? "";
  assert.include(comment, "Refresh log  (2 updates)");
  assert.include(comment, "#0 08-30 00:13");
  assert.include(comment, "#1 08-30 06:17  hyprws  o--X--o--o--S  v1.2.0  2c");
  assert.strictEqual(comment.match(/^#\d+ /gm)?.length, 2);
  assert.strictEqual(comment.match(/^```text$/gm)?.length, 1);
  assert.strictEqual(comment.match(/^```$/gm)?.length, 1);
  assert.deepStrictEqual(client.commentEdits, [100]);
  assert.strictEqual(client.issues[0]?.title, originalTitle);
});

it("closes the resolved sha with one comment and creates nothing", () => {
  const client = new FakeGitHub();
  reconcileRebaseBlock(client, input(blocked(SHA_A)), new Date("2026-08-30T00:13:00Z"));
  client.created.length = 0;

  reconcileRebaseBlock(client, input(null), new Date("2026-08-30T06:17:00Z"));

  assert.deepStrictEqual(client.closed, [1]);
  assert.strictEqual(client.created.length, 0);
  assert.strictEqual(client.comments.get(1)?.at(-1)?.body, `Resolved by hyprws ${"c".repeat(40)}.`);
  assert.strictEqual(openIssues(client).length, 0);
});

it("never refiles a sha already carried by a closed issue", () => {
  const report = blocked(SHA_A);
  const client = new FakeGitHub([
    {
      number: 7,
      nodeId: "issue-7",
      state: "closed",
      title: report.title,
      body: report.body,
      issueType: "Bug",
    },
  ]);

  reconcileRebaseBlock(client, input(report), new Date("2026-08-30T00:13:00Z"));

  assert.strictEqual(client.created.length, 0);
  assert.strictEqual(openIssues(client).length, 0);
});

it("refreshes a matching issue found by the pre-create re-read instead of creating", () => {
  const report = blocked(SHA_A);
  const client = new FakeGitHub();
  client.beforeList = (call) => {
    if (call !== 2) return;
    client.issues.push({
      number: 9,
      nodeId: "issue-9",
      state: "open",
      title: report.title,
      body: report.body,
      issueType: "Bug",
    });
  };

  reconcileRebaseBlock(client, input(report), new Date("2026-08-30T00:13:00Z"));

  assert.strictEqual(client.listCalls, 2);
  assert.deepStrictEqual(client.created, []);
  assert.deepStrictEqual(client.bodyEdits, [9]);
  assert.strictEqual(client.comments.get(9)?.length, 1);
});

it("closes the old identity before creating a new one and leaves at most one open", () => {
  const old = blocked(SHA_A);
  const client = new FakeGitHub([
    {
      number: 4,
      nodeId: "issue-4",
      state: "open",
      title: old.title,
      body: old.body,
      issueType: "Bug",
    },
  ]);

  reconcileRebaseBlock(client, input(blocked(SHA_B)), new Date("2026-08-30T00:13:00Z"));

  assert.deepStrictEqual(client.closed, [4]);
  assert.strictEqual(client.created.length, 1);
  assert.strictEqual(openIssues(client).length, 1);
  assert.include(openIssues(client)[0]?.body ?? "", `<!-- blocking-sha:${SHA_B} -->`);
});
