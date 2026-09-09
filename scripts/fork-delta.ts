#!/usr/bin/env node

// Renders the fork ledger for `RSI-Software/t3code-hyprws` from commit trailers.
// Every fork commit above upstream carries `Fork-Domain` and `Fork-Tier`; this
// script lists them by domain and, with `--check`, fails when one is missing.
// See docs/internals/fork-delta.md for the conventions it enforces.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import {
  budgetFindings,
  budgetRaises,
  forkBudgetFindingMessage,
  FORK_BUDGET_PATH,
  parseForkBudget,
  renderForkBudget,
  type ForkBudget,
  type ForkBudgetRaise,
} from "./lib/fork-budget.ts";
import { overlapPaths } from "./lib/fork-overlap.ts";
import {
  commitNumstatArguments,
  EMPTY_NUMSTAT,
  parseCommitNumstat,
  type CommitNumstat,
} from "./lib/fork-numstat.ts";
import {
  forkLogArguments,
  isForkBudgetRaise,
  isForkDomain,
  isForkUpstreamable,
  parseForkLog,
  parseForkTrailers,
} from "./lib/fork-trailers.ts";
import {
  compareWireShapes,
  parseForkWireBaseline,
  wireFindingKey,
  type ForkWireBaseline,
  type WireShapeFinding,
} from "./lib/fork-wire-shapes.ts";
import {
  EMPTY_RETIREMENT_LEDGER,
  readForkRetirementLedger,
  retirementDecision,
  type ForkRetirementLedger,
} from "./lib/fork-retirement-ledger.ts";

export const ForkTier = Schema.Literals(["core", "qol", "bugfix"]);
export type ForkTier = typeof ForkTier.Type;

const TIER_ORDER: ReadonlyArray<ForkTier> = ["core", "qol", "bugfix"];

const OptionalTrailer = Schema.optionalKey(Schema.String);

export const ForkCommit = Schema.Struct({
  sha: Schema.String,
  short: Schema.String,
  subject: Schema.String,
  domain: OptionalTrailer,
  tier: OptionalTrailer,
  upstreamable: OptionalTrailer,
  wireReviewed: OptionalTrailer,
  budget: OptionalTrailer,
  repair: OptionalTrailer,
});
export type ForkCommit = typeof ForkCommit.Type;

export const ForkFinding = Schema.Struct({
  short: Schema.String,
  subject: Schema.String,
  problem: Schema.String,
});
export type ForkFinding = typeof ForkFinding.Type;

export const ForkLedger = Schema.Struct({
  base: Schema.String,
  head: Schema.String,
  commits: Schema.Array(ForkCommit),
  findings: Schema.Array(ForkFinding),
  warnings: Schema.Array(Schema.String),
});
export type ForkLedger = typeof ForkLedger.Type;

const encodeLedgerJson = Schema.encodeSync(fromJsonStringPretty(ForkLedger));

export class ForkLogProcessError extends Schema.TaggedError<ForkLogProcessError>()(
  "ForkLogProcessError",
  {
    operation: Schema.Literals(["spawn", "read-stdout", "read-stderr", "wait-for-exit"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the fork log during process operation "${this.operation}".`;
  }
}

export class ForkLogExitError extends Schema.TaggedError<ForkLogExitError>()(
  "ForkLogExitError",
  {
    exitCode: Schema.Number,
    stderr: Schema.String,
  },
) {
  override get message(): string {
    return `git log exited with code ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

export {
  commitNumstatArguments,
  parseCommitNumstat,
  type CommitNumstat,
} from "./lib/fork-numstat.ts";
export class ForkBudgetError extends Schema.TaggedError<ForkBudgetError>()("ForkBudgetError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `${FORK_BUDGET_PATH} is invalid: ${this.reason}`;
  }
}

export { forkLogArguments, parseForkLog } from "./lib/fork-trailers.ts";

// A pull request lands as one squash commit whose body is the pull-request
// body, so the trailer block git will see is that body's last paragraph. Trailing
// HTML comments (the landing tool's attestation) are dropped first, because the
// landing tool strips them before composing the commit message.
export const squashTrailers = (body: string): string => {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1]?.trim() ?? "";
    if (last.length === 0 || (last.startsWith("<!--") && last.endsWith("-->"))) {
      lines.pop();
      continue;
    }
    break;
  }
  const paragraph: Array<string> = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) break;
    paragraph.unshift(line);
  }
  return paragraph.every((line) => /^[A-Za-z][A-Za-z0-9-]*:\s*\S/.test(line))
    ? paragraph.join("\n")
    : "";
};

export const parseSquashBody = (subject: string, body: string): ForkCommit => ({
  sha: "squash",
  short: "squash",
  subject,
  ...parseForkTrailers(squashTrailers(body)),
});

export const isReviewedWireTrailer = (value: string | undefined): boolean =>
  value !== undefined && /^reviewed\s+\S/i.test(value);

const isForkTier = (value: string | undefined): value is ForkTier =>
  value !== undefined && (ForkTier.literals as ReadonlyArray<string>).includes(value);

export const collectFindings = (commits: ReadonlyArray<ForkCommit>): ReadonlyArray<ForkFinding> =>
  commits.flatMap((commit) => {
    const problems: Array<string> = [];
    if (commit.domain === undefined) problems.push("missing Fork-Domain");
    else if (!isForkDomain(commit.domain)) {
      problems.push(`unknown Fork-Domain "${commit.domain}"`);
    }
    if (commit.tier === undefined) problems.push("missing Fork-Tier");
    else if (!isForkTier(commit.tier)) {
      problems.push(
        `unknown Fork-Tier "${commit.tier}" (expected ${ForkTier.literals.join(", ")})`,
      );
    }
    if (commit.tier === "bugfix" && commit.upstreamable === undefined) {
      problems.push("bugfix without Fork-Upstreamable");
    } else if (commit.upstreamable !== undefined && !isForkUpstreamable(commit.upstreamable)) {
      problems.push(`unknown Fork-Upstreamable "${commit.upstreamable}" (expected yes or no)`);
    }
    if (commit.budget !== undefined && !isForkBudgetRaise(commit.budget)) {
      problems.push('Fork-Budget must be "raise <reason>"');
    }
    return problems.map((problem) => ({ short: commit.short, subject: commit.subject, problem }));
  });

export const buildLedger = (
  base: string,
  head: string,
  commits: ReadonlyArray<ForkCommit>,
  retirementLedger: ForkRetirementLedger = EMPTY_RETIREMENT_LEDGER,
  wireFindings: ReadonlyMap<string, ReadonlyArray<WireShapeFinding>> = new Map(),
  wireBaseline: ForkWireBaseline = new Map(),
): ForkLedger => {
  const retired = commits.filter(
    (commit) => retirementDecision(retirementLedger, commit.subject).decision === "retire",
  );
  const active = commits.filter(
    (commit) => retirementDecision(retirementLedger, commit.subject).decision !== "retire",
  );
  const wireRows = active.flatMap((commit) =>
    (wireFindings.get(commit.sha) ?? []).map((finding) => ({
      commit,
      finding,
      key: wireFindingKey(commit.subject, finding),
    })),
  );
  const producedWireKeys = new Set(wireRows.map((row) => row.key));
  return {
    base,
    head,
    commits: active,
    findings: [
      ...collectFindings(active),
      ...wireRows.flatMap(({ commit, finding, key }) =>
        isReviewedWireTrailer(commit.wireReviewed) || wireBaseline.has(key)
          ? []
          : [
              {
                short: commit.short,
                subject: commit.subject,
                problem: `${finding.schema}: ${finding.change}; ${finding.hint}`,
              },
            ],
      ),
      ...retired.map((commit) => ({
        short: commit.short,
        subject: commit.subject,
        problem: "retired but present",
      })),
    ],
    warnings: [...wireBaseline.keys()]
      .filter((key) => !producedWireKeys.has(key))
      .map((key) => `stale wire baseline: ${key}`),
  };
};

export const buildSquashLedger = (
  base: string,
  head: string,
  body: string,
  wireFindings: ReadonlyArray<WireShapeFinding>,
): ForkLedger => {
  const commit = parseSquashBody("pull-request body", body);
  return buildLedger(
    base,
    head,
    [commit],
    EMPTY_RETIREMENT_LEDGER,
    new Map([[commit.sha, wireFindings]]),
  );
};

// Narrows the ledger to one domain so its commits can be extracted as a unit.
// Returns null when no fork commit carries that domain.
export const selectDomain = (ledger: ForkLedger, domain: string): ForkLedger | null => {
  const commits = ledger.commits.filter((commit) => commit.domain === domain);
  if (commits.length === 0) return null;
  const shorts = new Set(commits.map((commit) => commit.short));
  return {
    ...ledger,
    commits,
    findings: ledger.findings.filter((finding) => shorts.has(finding.short)),
  };
};

// One full SHA per line in stack order, ready for `git cherry-pick`.
export const renderShas = (ledger: ForkLedger): string =>
  ledger.commits.map((commit) => `${commit.sha}\n`).join("");

// Unknown tiers sort after the known ones so a typo is visible at the bottom.
const tierRank = (tier: string | undefined) => {
  const index = isForkTier(tier) ? TIER_ORDER.indexOf(tier) : -1;
  return index === -1 ? TIER_ORDER.length : index;
};

const escapeCell = (value: string) => value.replaceAll("|", "\\|");

export const renderMarkdown = (ledger: ForkLedger): string => {
  const lines: Array<string> = [];
  const domains = [...new Set(ledger.commits.flatMap((c) => (c.domain ? [c.domain] : [])))];

  lines.push(`# Fork delta: \`${ledger.head}\` over \`${ledger.base}\``, "");
  lines.push(
    `${ledger.commits.length} fork commits across ${domains.length} domain${domains.length === 1 ? "" : "s"}.`,
  );
  lines.push("Rows keep stack order: the first row sits closest to upstream.", "");

  for (const domain of domains) {
    const rows = ledger.commits
      .filter((c) => c.domain === domain)
      .toSorted((left, right) => tierRank(left.tier) - tierRank(right.tier));
    lines.push(`## ${domain}`, "");
    lines.push("| Tier | Commit | Change | Upstreamable | Wire review |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of rows) {
      lines.push(
        `| ${row.tier ?? "?"} | \`${row.short}\` | ${escapeCell(row.subject)} | ${row.upstreamable ?? ""} | ${row.wireReviewed ?? ""} |`,
      );
    }
    lines.push("");
  }

  if (ledger.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of ledger.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  if (ledger.findings.length > 0) {
    lines.push("## Untagged", "");
    lines.push("| Commit | Change | Problem |");
    lines.push("| --- | --- | --- |");
    for (const finding of ledger.findings) {
      lines.push(
        `| \`${finding.short}\` | ${escapeCell(finding.subject)} | ${escapeCell(finding.problem)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};

// -- Inventory (`--inventory`) ------------------------------------------------

export const ForkInventoryCommit = Schema.Struct({
  short: Schema.String,
  domain: Schema.String,
  tier: Schema.String,
  upstreamable: Schema.String,
  files: Schema.Number,
  overlaps: Schema.Number,
});
export type ForkInventoryCommit = typeof ForkInventoryCommit.Type;

export const ForkInventoryDomain = Schema.Struct({
  domain: Schema.String,
  commits: Schema.Number,
  added: Schema.Number,
  deleted: Schema.Number,
  files: Schema.Number,
  overlaps: Schema.Number,
});
export type ForkInventoryDomain = typeof ForkInventoryDomain.Type;

export const ForkInventory = Schema.Struct({
  base: Schema.String,
  head: Schema.String,
  target: Schema.String,
  domains: Schema.Array(ForkInventoryDomain),
  commits: Schema.Array(ForkInventoryCommit),
  /** The distinct files the stack touches; the Total row counts this, not the per-domain sum. */
  distinctFiles: Schema.Number,
});
export type ForkInventory = typeof ForkInventory.Type;

const encodeInventoryJson = Schema.encodeSync(fromJsonStringPretty(ForkInventory));

// Per-domain and per-commit views of the same stack. A commit's overlap count
// uses its own files against both net diffs; a domain aggregates its commits'
// lines and files, so a file two of its commits touch is counted once.
export const buildInventory = (input: {
  readonly base: string;
  readonly head: string;
  readonly target: string;
  readonly commits: ReadonlyArray<ForkCommit>;
  readonly statsBySha: ReadonlyMap<string, CommitNumstat>;
  readonly forkChanged: ReadonlySet<string>;
  readonly upstreamChanged: ReadonlySet<string>;
}): ForkInventory => {
  const commitRows: Array<ForkInventoryCommit> = [];
  const buckets = new Map<
    string,
    { commits: number; added: number; deleted: number; files: Set<string> }
  >();
  const distinctFiles = new Set<string>();

  for (const commit of input.commits) {
    const stats = input.statsBySha.get(commit.sha) ?? EMPTY_NUMSTAT;
    commitRows.push({
      short: commit.short,
      domain: commit.domain ?? "?",
      tier: commit.tier ?? "?",
      upstreamable: commit.upstreamable ?? "",
      files: stats.files.length,
      overlaps: overlapPaths(stats.files, input.forkChanged, input.upstreamChanged).length,
    });
    // A walk repair commit is the walk's own bookkeeping, not a domain's change:
    // it stays visible in the per-commit table but its lines never count toward
    // the budget sums, and it cannot author a raise trailer.
    if (commit.repair !== undefined) continue;
    for (const path of stats.files) distinctFiles.add(path);
    if (commit.domain === undefined) continue;
    const bucket = buckets.get(commit.domain) ?? {
      commits: 0,
      added: 0,
      deleted: 0,
      files: new Set<string>(),
    };
    bucket.commits += 1;
    bucket.added += stats.added;
    bucket.deleted += stats.deleted;
    for (const path of stats.files) bucket.files.add(path);
    buckets.set(commit.domain, bucket);
  }

  const domains = [...buckets]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([domain, bucket]): ForkInventoryDomain => ({
      domain,
      commits: bucket.commits,
      added: bucket.added,
      deleted: bucket.deleted,
      files: bucket.files.size,
      overlaps: overlapPaths(bucket.files, input.forkChanged, input.upstreamChanged).length,
    }));

  return {
    base: input.base,
    head: input.head,
    target: input.target,
    domains,
    commits: commitRows,
    distinctFiles: distinctFiles.size,
  };
};

export const renderInventory = (inventory: ForkInventory): string => {
  const totals = inventory.domains.reduce(
    (sum, row) => ({
      commits: sum.commits + row.commits,
      added: sum.added + row.added,
      deleted: sum.deleted + row.deleted,
      files: sum.files + row.files,
      overlaps: sum.overlaps + row.overlaps,
    }),
    { commits: 0, added: 0, deleted: 0, files: 0, overlaps: 0 },
  );
  const lines: Array<string> = [
    `# Fork delta inventory: \`${inventory.head}\` over \`${inventory.base}\` against \`${inventory.target}\``,
    "",
  ];
  lines.push(
    `${totals.commits} fork commits across ${inventory.domains.length} domain${inventory.domains.length === 1 ? "" : "s"}. Shared counts a file the fork changed above the shared base that upstream also changed on the way to ${inventory.target} (the fork:scan overlap definition).`,
    "",
  );
  lines.push("## Domains", "");
  lines.push("| Domain | Commits | Added | Deleted | Files | Shared |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of inventory.domains) {
    lines.push(
      `| ${row.domain} | ${row.commits} | ${row.added} | ${row.deleted} | ${row.files} | ${row.overlaps} |`,
    );
  }
  // The Total Files cell is the distinct count across domains, not the per-domain
  // sum: a shared file counts once for the stack, while the Shared column keeps its
  // per-attribution totals.
  lines.push(
    `| Total | ${totals.commits} | ${totals.added} | ${totals.deleted} | ${inventory.distinctFiles} | ${totals.overlaps} |`,
    "",
  );
  lines.push("## Commits", "");
  lines.push("| Commit | Domain | Tier | Upstreamable | Files | Shared |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of inventory.commits) {
    lines.push(
      `| \`${row.short}\` | ${row.domain} | ${row.tier} | ${row.upstreamable} | ${row.files} | ${row.overlaps} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runGit = Effect.fn("runForkDeltaGit")(function* (args: ReadonlyArray<string>, cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(ChildProcess.make("git", args, { cwd }))
    .pipe(Effect.mapError((cause) => new ForkLogProcessError({ operation: "spawn", cause })));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout).pipe(
        Effect.mapError((cause) => new ForkLogProcessError({ operation: "read-stdout", cause })),
      ),
      collectStreamAsString(child.stderr).pipe(
        Effect.mapError((cause) => new ForkLogProcessError({ operation: "read-stderr", cause })),
      ),
      child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError((cause) => new ForkLogProcessError({ operation: "wait-for-exit", cause })),
      ),
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

export const readForkLog = Effect.fn("readForkLog")(function* (
  base: string,
  head: string,
  cwd = process.cwd(),
) {
  const result = yield* runGit(forkLogArguments(base, head), cwd);
  if (result.exitCode !== 0) {
    return yield* new ForkLogExitError({ exitCode: result.exitCode, stderr: result.stderr });
  }
  return parseForkLog(result.stdout);
});

const readDiffPaths = Effect.fn("readInventoryDiffPaths")(function* (from: string, to: string) {
  const result = yield* runGit(
    ["-c", "core.quotePath=false", "diff", "--name-only", `${from}..${to}`],
    process.cwd(),
  );
  if (result.exitCode !== 0) {
    return yield* new ForkLogExitError({ exitCode: result.exitCode, stderr: result.stderr });
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
});

const readCommitNumstat = Effect.fn("readInventoryCommitNumstat")(function* (
  shas: ReadonlyArray<string>,
) {
  if (shas.length === 0) return new Map<string, CommitNumstat>();
  const result = yield* runGit(commitNumstatArguments(shas), process.cwd());
  if (result.exitCode !== 0) {
    return yield* new ForkLogExitError({ exitCode: result.exitCode, stderr: result.stderr });
  }
  return parseCommitNumstat(result.stdout);
});

// The stack inventory: every fork commit above the merge base with the upstream
// target, measured against the net fork and upstream diffs. Both --inventory and
// the budget (--check, --seed-budget) read exactly these numbers.
const collectInventory = Effect.fn("collectForkInventory")(function* (
  target: string,
  head: string,
) {
  const base = yield* resolveMergeBase(target, head, process.cwd());
  const commits = yield* readForkLog(base, head);
  const [forkChanged, upstreamChanged, statsBySha] = yield* Effect.all(
    [
      readDiffPaths(base, head),
      readDiffPaths(base, target),
      readCommitNumstat(commits.map(({ sha }) => sha)),
    ],
    { concurrency: "unbounded" },
  );
  return buildInventory({
    base,
    head,
    target,
    commits,
    statsBySha,
    forkChanged: new Set(forkChanged),
    upstreamChanged: new Set(upstreamChanged),
  });
});

// The commits above `base` that wrote the budget file, oldest first, so a raise
// can be tied to the exact commit that raised it.
const readBudgetCommitShas = Effect.fn("readBudgetCommitShas")(function* (
  base: string,
  head: string,
) {
  const result = yield* runGit(
    ["log", "--reverse", "--format=%H", `${base}..${head}`, "--", FORK_BUDGET_PATH],
    process.cwd(),
  );
  if (result.exitCode !== 0) {
    return yield* new ForkLogExitError({ exitCode: result.exitCode, stderr: result.stderr });
  }
  return result.stdout
    .split("\n")
    .map((sha) => sha.trim())
    .filter((sha) => sha.length > 0);
});

// A plain comparison so the parse failure stays out of the Effect error channel.
const raisesOrParseProblem = (
  before: string | undefined,
  after: string,
): { readonly raises: ReadonlyArray<ForkBudgetRaise> } | { readonly problem: string } => {
  try {
    return { raises: budgetRaises(before, after) };
  } catch (error) {
    return {
      problem: `${FORK_BUDGET_PATH} does not parse at this commit: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// A commit that pushes a budget ceiling up owes `Fork-Budget: raise <reason>` in
// its own message; the trailer is the audit, not anything stamped in the file.
// Adding the file is the initial seed — there is no prior baseline to raise
// from — so it is not a raise. Removing an established baseline is refused
// outright: ceilings ratchet down, they never disappear, and no trailer turns
// a deletion into a ratchet.
export const collectBudgetRaiseFindings = Effect.fn("collectBudgetRaiseFindings")(function* (
  commits: ReadonlyArray<ForkCommit>,
  base: string,
  head: string,
  cwd = process.cwd(),
) {
  const shas = yield* readBudgetCommitShas(base, head);
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const findings: Array<ForkFinding> = [];
  for (const sha of shas) {
    const commit = bySha.get(sha);
    if (commit === undefined) continue;
    const [before, after] = yield* Effect.all(
      [
        readRevisionPath(`${sha}^:${FORK_BUDGET_PATH}`, cwd),
        readRevisionPath(`${sha}:${FORK_BUDGET_PATH}`, cwd),
      ],
      { concurrency: "unbounded" },
    );
    if (after.trim().length === 0) {
      if (before.trim().length > 0) {
        findings.push({
          short: commit.short,
          subject: commit.subject,
          problem: `removes ${FORK_BUDGET_PATH}; the budget never ratchets to absent — lower the ceilings instead`,
        });
      }
      continue;
    }
    const outcome = raisesOrParseProblem(before.trim().length === 0 ? undefined : before, after);
    if ("problem" in outcome) {
      findings.push({ short: commit.short, subject: commit.subject, problem: outcome.problem });
      continue;
    }
    if (outcome.raises.length > 0 && !isForkBudgetRaise(commit.budget)) {
      const detail = outcome.raises
        .map((raise) => `${raise.domain} ${raise.measure} ${raise.from} -> ${raise.to}`)
        .join(", ");
      findings.push({
        short: commit.short,
        subject: commit.subject,
        problem: `raises ${detail} without Fork-Budget: raise <reason>`,
      });
    }
  }
  return findings;
});

// The squash-body check (hyprws-body CI) sees one prospective commit: a
// budget-baseline change between --base and --head lands inside the squashed
// commit, so its raise trailer must come from the body's final trailer
// paragraph. Adding the file is the initial seed and is not a raise; removing
// an established baseline is refused outright, exactly like the per-commit
// check.
export const collectSquashBudgetRaiseFindings = Effect.fn("collectSquashBudgetRaiseFindings")(
  function* (base: string, head: string, budget: string | undefined, cwd = process.cwd()) {
    const [before, after] = yield* Effect.all(
      [
        readRevisionPath(`${base}:${FORK_BUDGET_PATH}`, cwd),
        readRevisionPath(`${head}:${FORK_BUDGET_PATH}`, cwd),
      ],
      { concurrency: "unbounded" },
    );
    if (after.trim().length === 0) {
      if (before.trim().length > 0) {
        return [
          {
            short: "squash",
            subject: "pull-request body",
            problem: `removes ${FORK_BUDGET_PATH}; the budget never ratchets to absent — lower the ceilings instead`,
          },
        ];
      }
      return [];
    }
    const outcome = raisesOrParseProblem(before.trim().length === 0 ? undefined : before, after);
    if ("problem" in outcome) {
      return [{ short: "squash", subject: "pull-request body", problem: outcome.problem }];
    }
    if (outcome.raises.length > 0 && !isForkBudgetRaise(budget)) {
      const detail = outcome.raises
        .map((raise) => `${raise.domain} ${raise.measure} ${raise.from} -> ${raise.to}`)
        .join(", ");
      return [
        {
          short: "squash",
          subject: "pull-request body",
          problem: `raises ${detail} without Fork-Budget: raise <reason>`,
        },
      ];
    }
    return [];
  },
);

const missingRevisionPath = (stderr: string): boolean =>
  /(?:does not exist in|exists on disk, but not in)/.test(stderr);

const readRevisionPath = Effect.fn("readForkWireRevisionPath")(function* (
  revisionPath: string,
  cwd: string,
) {
  const result = yield* runGit(["show", revisionPath], cwd);
  if (result.exitCode === 0) return result.stdout;
  if (missingRevisionPath(result.stderr)) return "";
  return yield* new ForkLogExitError({ exitCode: result.exitCode, stderr: result.stderr });
});

const resolveMergeBase = Effect.fn("resolveForkWireMergeBase")(function* (
  base: string,
  head: string,
  cwd: string,
) {
  const result = yield* runGit(["merge-base", base, head], cwd);
  const mergeBase = result.stdout.trim();
  if (result.exitCode !== 0 || mergeBase.length === 0) {
    return yield* new ForkLogExitError({
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      stderr: result.stderr || `no merge base between ${base} and ${head}`,
    });
  }
  return mergeBase;
});

export const collectWireShapeFindingsBetween = Effect.fn("collectWireShapeFindingsBetween")(
  function* (base: string, head: string, cwd = process.cwd()) {
    const mergeBase = yield* resolveMergeBase(base, head, cwd);
    const changed = yield* runGit(
      ["diff", "--name-only", mergeBase, head, "--", "packages/contracts/src"],
      cwd,
    );
    if (changed.exitCode !== 0) {
      return yield* new ForkLogExitError({
        exitCode: changed.exitCode,
        stderr: changed.stderr,
      });
    }
    const paths = [
      ...new Set(
        changed.stdout
          .split("\n")
          .map((path) => path.trim())
          .filter((path) => path.startsWith("packages/contracts/src/")),
      ),
    ];
    const findings = yield* Effect.forEach(
      paths,
      (path) =>
        Effect.gen(function* () {
          const [before, after] = yield* Effect.all(
            [
              readRevisionPath(`${mergeBase}:${path}`, cwd),
              readRevisionPath(`${head}:${path}`, cwd),
            ],
            { concurrency: "unbounded" },
          );
          return compareWireShapes(before, after, path);
        }),
      { concurrency: 4 },
    );
    return findings.flat();
  },
);

export const collectWireShapeFindings = Effect.fn("collectWireShapeFindings")(function* (
  commits: ReadonlyArray<ForkCommit>,
  cwd = process.cwd(),
) {
  const entries = yield* Effect.forEach(
    commits,
    (commit) =>
      Effect.gen(function* () {
        if (isReviewedWireTrailer(commit.wireReviewed)) {
          return [commit.sha, [] as ReadonlyArray<WireShapeFinding>] as const;
        }
        const findings = yield* collectWireShapeFindingsBetween(`${commit.sha}^`, commit.sha, cwd);
        return [commit.sha, findings] as const;
      }),
    { concurrency: 4 },
  );
  return new Map(entries);
});

const command = Command.make(
  "fork-delta",
  {
    base: Flag.string("base").pipe(
      Flag.withDescription(
        "Base ref; defaults to upstream/main except --squash-body requires it explicitly.",
      ),
      Flag.optional,
    ),
    head: Flag.string("head").pipe(
      Flag.withDescription(
        "Head ref; defaults to HEAD except --squash-body requires it explicitly.",
      ),
      Flag.optional,
    ),
    check: Flag.boolean("check").pipe(
      Flag.withDescription(
        "Exit 1 when a fork commit has invalid trailers, changes a shipped wire shape, or is still present after retirement.",
      ),
      Flag.withDefault(false),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print the ledger as JSON instead of Markdown."),
      Flag.withDefault(false),
    ),
    domain: Flag.string("domain").pipe(
      Flag.withDescription("Limit the ledger to one Fork-Domain."),
      Flag.optional,
    ),
    shas: Flag.boolean("shas").pipe(
      Flag.withDescription(
        "Print one full SHA per line in stack order, for `git cherry-pick` onto upstream.",
      ),
      Flag.withDefault(false),
    ),
    inventory: Flag.boolean("inventory").pipe(
      Flag.withDescription(
        "Print the per-domain and per-commit delta inventory instead of the ledger.",
      ),
      Flag.withDefault(false),
    ),
    seedBudget: Flag.boolean("seed-budget").pipe(
      Flag.withDescription(
        `Write ${FORK_BUDGET_PATH} from the live inventory. The seeding commit carries Fork-Budget: raise <reason> like any raise.`,
      ),
      Flag.withDefault(false),
    ),
    upstream: Flag.string("upstream").pipe(
      Flag.withDescription(
        "With --inventory, the upstream target to compare against (default: upstream/main).",
      ),
      Flag.optional,
    ),
    squashBody: Flag.string("squash-body").pipe(
      Flag.withDescription(
        "With --check, verify the base-to-head squash and the pull-request body's final trailer block.",
      ),
      Flag.optional,
    ),
  },
  ({ base, head, check, json, domain, shas, squashBody, inventory, upstream, seedBudget }) =>
    Effect.gen(function* () {
      if (seedBudget) {
        const conflicting = [
          ...(check ? ["--check"] : []),
          ...(inventory ? ["--inventory"] : []),
          ...(json ? ["--json"] : []),
          ...(Option.isSome(domain) ? ["--domain"] : []),
          ...(shas ? ["--shas"] : []),
          ...(Option.isSome(squashBody) ? ["--squash-body"] : []),
          ...(Option.isSome(base) ? ["--base"] : []),
          ...(Option.isSome(head) ? ["--head"] : []),
        ];
        if (conflicting.length > 0) {
          process.stderr.write(
            `failed: --seed-budget takes no other mode flags (conflicting: ${conflicting.join(" ")})\n`,
          );
          process.exitCode = 2;
          return;
        }
        const target = Option.getOrElse(upstream, () => "upstream/main");
        const inventoryTable = yield* collectInventory(
          target,
          Option.getOrElse(head, () => "HEAD"),
        );
        // The seeding commit lands the table itself, and its lines count toward
        // its own domain: fork-meta's Added ceiling carries the table's own
        // lines so the documented seed -> commit -> check workflow lands green.
        const rows = inventoryTable.domains.some((row) => row.domain === "fork-meta")
          ? inventoryTable.domains
          : [
              ...inventoryTable.domains,
              { domain: "fork-meta", commits: 0, added: 0, deleted: 0, files: 0, overlaps: 0 },
            ];
        const withHeadroom = rows.map((row) =>
          row.domain === "fork-meta"
            ? {
                ...row,
                added: row.added + renderForkBudget({ rows }).split("\n").length - 1,
              }
            : row,
        );
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(
          FORK_BUDGET_PATH,
          renderForkBudget({ rows: withHeadroom }),
        );
        process.stdout.write(
          `ok: ${FORK_BUDGET_PATH} seeded for ${withHeadroom.length} domains; fork-meta Added carries the table's own lines; commit the file — the initial seed carries no Fork-Budget raise trailer\n`,
        );
        return;
      }
      if (Option.isSome(squashBody)) {
        const missingRefs = [
          ...(Option.isNone(base) ? ["--base"] : []),
          ...(Option.isNone(head) ? ["--head"] : []),
        ];
        if (missingRefs.length > 0) {
          process.stderr.write(
            `failed: --squash-body requires explicit ${missingRefs.join(" and ")}\n`,
          );
          process.exitCode = 2;
          return;
        }
        const squashBase = Option.getOrThrow(base);
        const squashHead = Option.getOrThrow(head);
        const fileSystem = yield* FileSystem.FileSystem;
        const body = yield* fileSystem.readFileString(squashBody.value);
        const wireFindings = yield* collectWireShapeFindingsBetween(squashBase, squashHead);
        const ledger = buildSquashLedger(squashBase, squashHead, body, wireFindings);
        // A squash lands as one commit, so a budget-baseline change rides on the
        // body's trailers: if the squash moves a gated ceiling up, the body must
        // carry Fork-Budget: raise <reason>. Adding the file is the initial seed —
        // there is no prior baseline, so it is not a raise.
        const squashBudgetFindings = yield* collectSquashBudgetRaiseFindings(
          squashBase,
          squashHead,
          parseSquashBody("pull-request body", body).budget,
        );
        for (const finding of [...ledger.findings, ...squashBudgetFindings]) {
          process.stderr.write(`${finding.subject}: ${finding.problem}\n`);
        }
        if (ledger.findings.length + squashBudgetFindings.length > 0) {
          process.stderr.write(
            `failed: the prospective squash is invalid; end the body with Fork-Domain and Fork-Tier and, when reported above, Fork-Wire: reviewed <reason> or Fork-Budget: raise <reason> (docs/internals/fork-delta.md)\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write("ok: prospective squash carries its fork trailers and wire review\n");
        return;
      }
      if (inventory) {
        if (Option.isSome(base)) {
          process.stderr.write(
            "failed: --inventory derives its base from the merge base of the upstream target and --head; --base is a ledger-only flag\n",
          );
          process.exitCode = 2;
          return;
        }
        const target = Option.getOrElse(upstream, () => "upstream/main");
        const inventoryHead = Option.getOrElse(head, () => "HEAD");
        const inventoryTable = yield* collectInventory(target, inventoryHead);
        process.stdout.write(
          json ? `${encodeInventoryJson(inventoryTable)}\n` : renderInventory(inventoryTable),
        );
        return;
      }
      const fileSystem = yield* FileSystem.FileSystem;
      const retirementLedger = readForkRetirementLedger(process.cwd());
      const wireBaseline = parseForkWireBaseline(
        yield* fileSystem.readFileString("docs/internals/fork-wire-baseline.md"),
      );
      const resolvedBase = Option.getOrElse(base, () => "upstream/main");
      const resolvedHead = Option.getOrElse(head, () => "HEAD");
      const commits = yield* readForkLog(resolvedBase, resolvedHead);
      const wireFindings = yield* collectWireShapeFindings(commits);
      const full = buildLedger(
        resolvedBase,
        resolvedHead,
        commits,
        retirementLedger,
        wireFindings,
        wireBaseline,
      );
      const ledger = Option.isSome(domain) ? selectDomain(full, domain.value) : full;
      if (ledger === null) {
        const name = Option.getOrElse(domain, () => "");
        process.stderr.write(`failed: no fork commit carries Fork-Domain "${name}"\n`);
        process.exitCode = 1;
        return;
      }
      if (shas) {
        process.stdout.write(renderShas(ledger));
        return;
      }
      if (check) {
        for (const warning of ledger.warnings) {
          process.stderr.write(`warning: ${warning}\n`);
        }
        // A raise is a trailer problem like any other: it fails with the ledger's
        // findings, naming the commit, the domain, and the numbers it pushed up.
        const raiseFindings = yield* collectBudgetRaiseFindings(
          ledger.commits,
          resolvedBase,
          resolvedHead,
        );
        const findings = [...ledger.findings, ...raiseFindings];
        for (const finding of findings) {
          process.stderr.write(`${finding.short} ${finding.subject}: ${finding.problem}\n`);
        }
        if (findings.length > 0) {
          process.stderr.write(`failed: ${findings.length} fork delta problem(s)\n`);
          process.exitCode = 1;
          return;
        }
        // The budget is a stack property measured against the upstream target, not
        // the ledger walk base, so it always reads the merge-base inventory. Until
        // a commit seeds the file there is no budget and the check skips it; a
        // merge base that has the file while the stack does not is a removed
        // baseline and is refused outright, with no trailer to excuse it.
        const budgetTarget = Option.getOrElse(upstream, () => "upstream/main");
        const budgetBase = yield* resolveMergeBase(budgetTarget, resolvedHead, process.cwd());
        const establishedBaseline = yield* readRevisionPath(
          `${budgetBase}:${FORK_BUDGET_PATH}`,
          process.cwd(),
        );
        const missingBaselineOutcome = (): Effect.Effect<
          { readonly removed: true } | {},
          never
        > => {
          if (establishedBaseline.trim().length === 0) return Effect.succeed({});
          process.stderr.write(
            `failed: ${FORK_BUDGET_PATH} is removed from the stack; the budget never ratchets to absent — lower the ceilings instead\n`,
          );
          process.exitCode = 1;
          return Effect.succeed({ removed: true } as const);
        };
        const budgetOutcome = yield* fileSystem.readFileString(FORK_BUDGET_PATH).pipe(
          Effect.option,
          Effect.flatMap(
            (
              maybeMarkdown,
            ): Effect.Effect<
              | { readonly budget?: ForkBudget }
              | { readonly removed: true }
              | { readonly invalid: string },
              ForkBudgetError
            > =>
              Option.isNone(maybeMarkdown)
                ? missingBaselineOutcome()
                : Effect.map(
                    Effect.try({
                      try: () => parseForkBudget(maybeMarkdown.value),
                      catch: (cause) =>
                        new ForkBudgetError({
                          reason: cause instanceof Error ? cause.message : String(cause),
                        }),
                    }),
                    (budget) => ({ budget }),
                  ),
          ),
          Effect.catch((error: ForkBudgetError) =>
            Effect.succeed({ invalid: error.reason } as const),
          ),
        );
        if ("invalid" in budgetOutcome) {
          process.stderr.write(
            `failed: ${FORK_BUDGET_PATH} is invalid: ${budgetOutcome.invalid}\n`,
          );
          process.exitCode = 1;
          return;
        }
        if ("removed" in budgetOutcome) return;
        if (budgetOutcome.budget !== undefined) {
          const budget = budgetOutcome.budget;
          for (const unknown of budget.unknownDomains) {
            process.stderr.write(`warning: fork budget row "${unknown}" is not a fork domain\n`);
          }
          const stack = yield* collectInventory(budgetTarget, resolvedHead);
          const overBudget = budgetFindings(stack.domains, budget);
          for (const finding of overBudget) {
            process.stderr.write(`over budget: ${forkBudgetFindingMessage(finding)}\n`);
          }
          if (overBudget.length > 0) {
            process.stderr.write(
              `failed: ${overBudget.length} fork budget ceiling(s) exceeded (${FORK_BUDGET_PATH})\n`,
            );
            process.exitCode = 1;
            return;
          }
        }
        process.stdout.write(`ok: ${ledger.commits.length} fork commits tagged\n`);
        return;
      }
      process.stdout.write(json ? `${encodeLedgerJson(ledger)}\n` : renderMarkdown(ledger));
    }),
).pipe(
  Command.withDescription(
    "List fork commits above upstream by Fork-Domain and Fork-Tier trailer, or verify every commit carries them.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
