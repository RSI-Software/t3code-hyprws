import { assert, it } from "@effect/vitest";

import {
  buildSweep,
  containsCommit,
  listWatchIssues,
  parseArgs,
  parseCitations,
  renderSweep,
  rollUpStatus,
  UsageError,
  type CitationResult,
  type CommandResult,
  type GitHubReader,
  type GitReader,
  type SweepOptions,
} from "./fork-upstream-watch.ts";

const UPSTREAM = "pingdotgg/t3code";
const FORK = "RSI-Software/t3code-hyprws";

const options = (overrides: Partial<SweepOptions> = {}): SweepOptions => ({
  fork: FORK,
  upstream: UPSTREAM,
  target: "v0.0.34",
  json: false,
  ...overrides,
});

class StubGit implements GitReader {
  readonly calls: Array<string> = [];

  private readonly known: ReadonlySet<string>;
  private readonly contained: ReadonlySet<string>;
  private readonly targetSha: string | null;

  constructor(
    known: ReadonlySet<string>,
    contained: ReadonlySet<string>,
    targetSha: string | null = "1".repeat(40),
  ) {
    this.known = known;
    this.contained = contained;
    this.targetSha = targetSha;
  }

  runResult(args: ReadonlyArray<string>): CommandResult {
    this.calls.push(args.join(" "));
    const empty = { stdout: "", stderr: "" };
    if (args[0] === "cat-file") {
      const sha = (args[2] ?? "").replace("^{commit}", "");
      return { status: this.known.has(sha) ? 0 : 128, ...empty };
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return this.targetSha === null
        ? { status: 128, ...empty }
        : { status: 0, stdout: `${this.targetSha}\n`, stderr: "" };
    }
    if (args[0] === "merge-base") {
      return { status: this.contained.has(args[2] ?? "") ? 0 : 1, ...empty };
    }
    return { status: 0, ...empty };
  }
}

class StubGitHub implements GitHubReader {
  readonly calls: Array<string> = [];

  private readonly responses: Readonly<Record<string, unknown>>;

  constructor(responses: Readonly<Record<string, unknown>>) {
    this.responses = responses;
  }

  read(args: ReadonlyArray<string>): CommandResult {
    const key = args.join(" ");
    this.calls.push(key);
    const match = Object.entries(this.responses).find(([pattern]) => key.includes(pattern));
    if (match !== undefined) return { status: 0, stdout: JSON.stringify(match[1]), stderr: "" };
    // The label probe exists on the fork unless a case stubs it as missing.
    if (key.includes("/labels/")) return { status: 0, stdout: "{}", stderr: "" };
    return { status: 1, stdout: "", stderr: `no stub for: ${key}` };
  }
}

// The sweep reads the REST issues endpoint, so a stubbed page carries `html_url`.
const issueList = (body: string, number = 99) => [
  {
    number,
    title: "Workspace file panel drops linked artifacts",
    html_url: `https://github.com/${FORK}/issues/${number}`,
    body,
  },
];

// Serves `page=N` of a synthetic open-issue list, so a walk over more than one page
// is exercised end to end instead of assumed.
class PagedGitHub implements GitHubReader {
  readonly pages: Array<number> = [];

  private readonly total: number;

  constructor(total: number) {
    this.total = total;
  }

  read(args: ReadonlyArray<string>): CommandResult {
    const request = args.join(" ");
    if (request.includes("/labels/")) return { status: 0, stdout: "{}", stderr: "" };
    // `&page=` and not `page=`, so `per_page` cannot answer for the page cursor.
    const page = Number.parseInt(/&page=(\d+)/.exec(request)?.[1] ?? "0", 10);
    this.pages.push(page);
    const start = (page - 1) * 100;
    const entries = Array.from(
      { length: Math.max(0, Math.min(100, this.total - start)) },
      (_, i) => ({
        number: start + i + 1,
        title: `watch ${start + i + 1}`,
        html_url: `https://github.com/${FORK}/issues/${start + i + 1}`,
        body: "no citation",
      }),
    );
    return { status: 0, stdout: JSON.stringify(entries), stderr: "" };
  }
}

// Serves `page=N` by offset over a set that loses one issue mid-walk, which is what a
// real close or label removal does. The dropped issue sat on a page the walk already
// read, so every later issue slides back one slot and a still-open issue lands behind
// the cursor. The short final page reads like a complete sweep either way.
class ShiftingGitHub implements GitHubReader {
  readonly walks: Array<Array<number>> = [];

  private numbers: Array<number>;
  private mutated = false;

  constructor(total: number) {
    this.numbers = Array.from({ length: total }, (_, index) => index + 1);
  }

  read(args: ReadonlyArray<string>): CommandResult {
    const request = args.join(" ");
    if (request.includes("/labels/")) return { status: 0, stdout: "{}", stderr: "" };
    const page = Number.parseInt(/&page=(\d+)/.exec(request)?.[1] ?? "0", 10);
    if (page === 1) this.walks.push([]);
    this.walks[this.walks.length - 1]?.push(page);

    const window = this.numbers.slice((page - 1) * 100, page * 100);
    // One issue leaves the set after the first page of the first walk is already read.
    if (page === 1 && !this.mutated) {
      this.mutated = true;
      this.numbers = this.numbers.filter((number) => number !== 6);
    }
    return {
      status: 0,
      stdout: JSON.stringify(
        window.map((number) => ({
          number,
          title: `watch ${number}`,
          html_url: `https://github.com/${FORK}/issues/${number}`,
          body: "no citation",
        })),
      ),
      stderr: "",
    };
  }
}

it("parses options and rejects malformed flags", () => {
  assert.deepStrictEqual(parseArgs(["--target", "v0.0.34", "--json"]), options({ json: true }));
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  assert.throws(() => parseArgs(["--target"]), UsageError);
  assert.throws(() => parseArgs(["--json", "--json"]), UsageError);
});

it("reads upstream citations only from code spans", () => {
  const body = [
    "A bare pingdotgg/t3code#1 must not count, because it notifies upstream.",
    "The real citation is `pingdotgg/t3code#4379`, repeated as `pingdotgg/t3code#4379`.",
    "An unrelated `vercel/next.js#77` is ignored, and `pingdotgg/t3code#12` also counts.",
  ].join("\n");
  assert.deepStrictEqual(parseCitations(body, UPSTREAM), [
    { slug: UPSTREAM, number: 12 },
    { slug: UPSTREAM, number: 4379 },
  ]);
  assert.deepStrictEqual(parseCitations("no citation here", UPSTREAM), []);
});

it("reports unknown containment instead of guessing when a ref is missing", () => {
  const sha = "a".repeat(40);
  const known = new StubGit(new Set([sha]), new Set([sha]));
  assert.strictEqual(containsCommit(known, sha, "v0.0.34"), true);

  const notContained = new StubGit(new Set([sha]), new Set());
  assert.strictEqual(containsCommit(notContained, sha, "v0.0.34"), false);

  const unfetched = new StubGit(new Set(), new Set([sha]));
  assert.strictEqual(containsCommit(unfetched, sha, "v0.0.34"), null);

  const noTarget = new StubGit(new Set([sha]), new Set([sha]), null);
  assert.strictEqual(containsCommit(noTarget, sha, "v0.0.34"), null);
});

it("marks a merged pull request contained in the target as ready", () => {
  const merge = "b".repeat(40);
  const gh = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#4379`."),
    "repos/pingdotgg/t3code/issues/4379": { state: "closed", pull_request: { url: "x" } },
    "repos/pingdotgg/t3code/pulls/4379": { merged: true, merge_commit_sha: merge, state: "closed" },
  });
  const sweep = buildSweep(gh, new StubGit(new Set([merge]), new Set([merge])), options());

  assert.strictEqual(sweep.issues.length, 1);
  assert.strictEqual(sweep.issues[0]?.status, "ready");
  assert.strictEqual(sweep.issues[0]?.citations[0]?.ref, "`pingdotgg/t3code#4379`");
  assert.strictEqual(sweep.issues[0]?.citations[0]?.mergeCommit, merge);
  assert.include(renderSweep(sweep), "verify it in the fork release and close there");
});

it("holds a merged pull request that the target does not contain", () => {
  const merge = "c".repeat(40);
  const gh = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#4379`."),
    "repos/pingdotgg/t3code/issues/4379": { state: "closed", pull_request: { url: "x" } },
    "repos/pingdotgg/t3code/pulls/4379": { merged: true, merge_commit_sha: merge, state: "closed" },
  });
  const sweep = buildSweep(gh, new StubGit(new Set([merge]), new Set()), options());

  assert.strictEqual(sweep.issues[0]?.status, "pending-tag");
  assert.include(sweep.issues[0]?.citations[0]?.detail ?? "", "not in v0.0.34");
});

it("separates an open pull request, a dropped one, and an upstream issue", () => {
  const open = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#4379`."),
    "repos/pingdotgg/t3code/issues/4379": { state: "open", pull_request: { url: "x" } },
    "repos/pingdotgg/t3code/pulls/4379": { merged: false, state: "open" },
  });
  assert.strictEqual(
    buildSweep(open, new StubGit(new Set(), new Set()), options()).issues[0]?.status,
    "waiting",
  );

  const dropped = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#4379`."),
    "repos/pingdotgg/t3code/issues/4379": { state: "closed", pull_request: { url: "x" } },
    "repos/pingdotgg/t3code/pulls/4379": { merged: false, state: "closed" },
  });
  assert.strictEqual(
    buildSweep(dropped, new StubGit(new Set(), new Set()), options()).issues[0]?.status,
    "dropped",
  );

  const issueOnly = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#4200`."),
    "repos/pingdotgg/t3code/issues/4200": { state: "open" },
  });
  const sweep = buildSweep(issueOnly, new StubGit(new Set(), new Set()), options());
  assert.strictEqual(sweep.issues[0]?.citations[0]?.kind, "issue");
  assert.strictEqual(sweep.issues[0]?.status, "waiting");
});

it("flags a watch issue whose body cites nothing upstream", () => {
  const gh = new StubGitHub({ "issues?state=open": issueList("No citation at all.") });
  const sweep = buildSweep(gh, new StubGit(new Set(), new Set()), options());

  assert.strictEqual(sweep.issues[0]?.status, "uncited");
  assert.include(renderSweep(sweep), "no upstream citation in the body");
});

it("rolls an issue up to its least advanced citation", () => {
  const citation = (status: CitationResult["status"]): CitationResult => ({
    ref: "`pingdotgg/t3code#1`",
    kind: "pull",
    state: "closed",
    mergeCommit: null,
    containedInTarget: null,
    status,
    detail: "",
  });

  assert.strictEqual(rollUpStatus([]), "uncited");
  assert.strictEqual(rollUpStatus([citation("ready"), citation("ready")]), "ready");
  assert.strictEqual(rollUpStatus([citation("ready"), citation("waiting")]), "waiting");
  assert.strictEqual(rollUpStatus([citation("unresolved"), citation("pending-tag")]), "unresolved");

  // A spent citation never outranks one that can still land, or the watch deadlocks.
  assert.strictEqual(rollUpStatus([citation("pending-tag"), citation("dropped")]), "pending-tag");
  assert.strictEqual(rollUpStatus([citation("ready"), citation("fix-uncited")]), "ready");
  assert.strictEqual(rollUpStatus([citation("ready"), citation("dropped")]), "ready");
  assert.strictEqual(rollUpStatus([citation("waiting"), citation("dropped")]), "waiting");

  // Spent citations still decide when nothing else can advance.
  assert.strictEqual(rollUpStatus([citation("dropped"), citation("fix-uncited")]), "fix-uncited");
  assert.strictEqual(rollUpStatus([citation("dropped")]), "dropped");
});

it("says so plainly when nothing waits on upstream", () => {
  const gh = new StubGitHub({ "issues?state=open": [] });
  const sweep = buildSweep(gh, new StubGit(new Set(), new Set()), options());

  assert.deepStrictEqual(sweep.issues, []);
  assert.include(renderSweep(sweep), "No open upstream-watch issues");
});

it("walks every page of open watch issues instead of capping the list", () => {
  // A set that fits in one request is one server-side snapshot; nothing can shift
  // across a page boundary that never existed, so a confirming walk would prove nothing.
  const one = new PagedGitHub(30);
  assert.strictEqual(listWatchIssues(one, FORK).length, 30);
  assert.deepStrictEqual(one.pages, [1]);

  // A multi-page set is walked again and believed once two walks agree.
  const many = new PagedGitHub(250);
  const issues = listWatchIssues(many, FORK);
  assert.strictEqual(issues.length, 250);
  assert.strictEqual(issues[0]?.number, 1);
  assert.strictEqual(issues[249]?.number, 250);
  assert.deepStrictEqual(many.pages, [1, 2, 3, 1, 2, 3]);

  // An exact multiple of the page size still asks for the page that proves the end.
  const exact = new PagedGitHub(100);
  assert.strictEqual(listWatchIssues(exact, FORK).length, 100);
  assert.deepStrictEqual(exact.pages, [1, 2, 1, 2]);
});

it("does not lose an issue when the open set shifts under the page walk", () => {
  const shifting = new ShiftingGitHub(150);
  const numbers = listWatchIssues(shifting, FORK).map((issue) => issue.number);

  // Issue 101 opened page 2 before the shift and slid onto the already-read page 1.
  // A single offset walk returns 149 issues without it and reads like a full sweep.
  assert.include(numbers, 101);
  assert.notInclude(numbers, 6);
  assert.strictEqual(numbers.length, 149);
  // The first walk is discarded; the two that agree are what the sweep reports.
  assert.deepStrictEqual(shifting.walks, [
    [1, 2],
    [1, 2],
    [1, 2],
  ]);
});

it("fails loudly when the open set never settles across walks", () => {
  let served = 0;
  const churning: GitHubReader = {
    read: (args) => {
      const request = args.join(" ");
      if (request.includes("/labels/")) return { status: 0, stdout: "{}", stderr: "" };
      const page = Number.parseInt(/&page=(\d+)/.exec(request)?.[1] ?? "0", 10);
      // Every walk sees one more issue than the last, so no two walks ever agree.
      if (page === 1) served += 1;
      const length = page === 1 ? 100 : served;
      return {
        status: 0,
        stdout: JSON.stringify(
          Array.from({ length }, (_, index) => ({
            number: (page - 1) * 100 + index + 1,
            body: "",
          })),
        ),
        stderr: "",
      };
    },
  };
  assert.throws(() => listWatchIssues(churning, FORK), /could have dropped an issue from/);
});

it("fails loudly rather than reporting a truncated sweep", () => {
  const endless: GitHubReader = {
    read: () => ({
      status: 0,
      stdout: JSON.stringify(
        Array.from({ length: 100 }, (_, index) => ({ number: index + 1, body: "" })),
      ),
      stderr: "",
    }),
  };
  assert.throws(
    () => listWatchIssues(endless, FORK),
    /refuses to report a list it had to truncate/,
  );
});

it("drops pull requests that the issues endpoint returns alongside issues", () => {
  const mixed: GitHubReader = {
    read: () => ({
      status: 0,
      stdout: JSON.stringify([
        { number: 7, title: "watch", html_url: "u", body: "b" },
        { number: 8, title: "pr", html_url: "u", body: "b", pull_request: { url: "x" } },
      ]),
      stderr: "",
    }),
  };
  assert.deepStrictEqual(
    listWatchIssues(mixed, FORK).map((issue) => issue.number),
    [7],
  );
});

it("does not strand a watch whose closed upstream issue names its fix", () => {
  const merge = "d".repeat(40);
  const body = "Upstream tracked it as `pingdotgg/t3code#4200`, fixed by `pingdotgg/t3code#4379`.";
  const gh = new StubGitHub({
    "issues?state=open": issueList(body),
    "repos/pingdotgg/t3code/issues/4200": { state: "closed" },
    "repos/pingdotgg/t3code/issues/4379": { state: "closed", pull_request: { url: "x" } },
    "repos/pingdotgg/t3code/pulls/4379": { merged: true, merge_commit_sha: merge, state: "closed" },
  });
  const sweep = buildSweep(gh, new StubGit(new Set([merge]), new Set([merge])), options());

  assert.strictEqual(sweep.issues[0]?.citations[0]?.status, "fix-uncited");
  assert.strictEqual(sweep.issues[0]?.citations[1]?.status, "ready");
  assert.strictEqual(sweep.issues[0]?.status, "ready");
});

it("asks for the fixing pull request when a closed upstream issue is the only citation", () => {
  const gh = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#4200`."),
    "repos/pingdotgg/t3code/issues/4200": { state: "closed" },
  });
  const sweep = buildSweep(gh, new StubGit(new Set(), new Set()), options());

  assert.strictEqual(sweep.issues[0]?.status, "fix-uncited");
  assert.include(renderSweep(sweep), "find the fixing pull request and cite it here");
});

// Real upstream closures of both kinds: `pingdotgg/t3code#7872` and `pingdotgg/t3code#7662`
// are closed `not_planned`, so no fixing pull request exists for either one to cite.
it("separates a completed upstream closure from one closed as not planned", () => {
  const completed = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#4200`."),
    "repos/pingdotgg/t3code/issues/4200": { state: "closed", state_reason: "completed" },
  });
  const fixUncited = buildSweep(completed, new StubGit(new Set(), new Set()), options());
  assert.strictEqual(fixUncited.issues[0]?.citations[0]?.status, "fix-uncited");
  assert.strictEqual(fixUncited.issues[0]?.status, "fix-uncited");
  assert.include(renderSweep(fixUncited), "closed as completed; find the fixing pull request");

  const notPlanned = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#7872`."),
    "repos/pingdotgg/t3code/issues/7872": { state: "closed", state_reason: "not_planned" },
  });
  const dropped = buildSweep(notPlanned, new StubGit(new Set(), new Set()), options());
  assert.strictEqual(dropped.issues[0]?.citations[0]?.status, "dropped");
  assert.strictEqual(dropped.issues[0]?.status, "dropped");
  assert.include(renderSweep(dropped), "closed as not planned");
  assert.notInclude(renderSweep(dropped), "find the fixing pull request");
});

it("aborts the sweep when a GitHub read fails instead of inventing a verdict", () => {
  const gh = new StubGitHub({
    "issues?state=open": issueList("Waiting on `pingdotgg/t3code#4379`."),
  });
  assert.throws(
    () => buildSweep(gh, new StubGit(new Set(), new Set()), options()),
    /no stub for: api repos\/pingdotgg\/t3code\/issues\/4379/,
  );
});

it("refuses to report an empty sweep when the label itself is missing", () => {
  const noLabel: GitHubReader = {
    read: (args) =>
      args.join(" ").includes("/labels/")
        ? { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }
        : { status: 0, stdout: "[]", stderr: "" },
  };
  assert.throws(() => listWatchIssues(noLabel, FORK), /an empty sweep would prove nothing/);
});
