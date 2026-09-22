#!/usr/bin/env node

// Renders the fork ledger for `RSI-Software/t3code-hyprws` from commit trailers.
// Gate: pull-request — the Fork ledger step of the hyprws-ci Check job and the release workflow's Fork ledger step; --check refuses untagged or retired-but-present commits.
// Every fork commit above upstream carries `Fork-Domain` and `Fork-Tier`; this
// script lists them by domain and, with `--check`, fails when one is missing.
// See docs/fork/internals/fork-delta.md for the conventions it enforces.

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
import { overlapPaths } from "./lib/fork-overlap.ts";
import {
  FORK_LOG_RECORD_SEPARATOR,
  forkLogArguments,
  isForkDomain,
  isForkUpstreamable,
  parseForkLog,
  parseForkTrailers,
  trailerBlock as squashTrailers,
} from "./lib/fork-trailers.ts";
import {
  EMPTY_RETIREMENT_LEDGER,
  readForkRetirementLedger,
  retirementDecision,
  type ForkRetirementLedger,
} from "./lib/fork-retirement-ledger.ts";

/** Lines added and deleted by one commit; the inventory derives them from `git show --numstat`. */
export interface CommitNumstat {
  readonly files: ReadonlyArray<string>;
  readonly added: number;
  readonly deleted: number;
}

export const EMPTY_NUMSTAT: CommitNumstat = { files: [], added: 0, deleted: 0 };

/** One numstat record per commit. `--no-renames` keeps every path a real path, so
 * a renamed file intersects the net fork and upstream diffs — which list the new
 * path only — exactly like fork:scan's `--name-only` commit lists do. */
export const commitNumstatArguments = (shas: ReadonlyArray<string>) =>
  [
    "-c",
    "core.quotePath=false",
    "show",
    "--numstat",
    "--no-renames",
    `--format=${FORK_LOG_RECORD_SEPARATOR}%H`,
    ...shas,
  ] as const;

/** The `added\tdeleted\tpath` rows of one numstat block. Binary files report "-"
 * for both counts; they still count as touched. */
export const parseNumstatRows = (rows: ReadonlyArray<string>): CommitNumstat => {
  let added = 0;
  let deleted = 0;
  const files: Array<string> = [];
  for (const row of rows) {
    const cells = row.split("\t");
    const path = (cells[2] ?? "").trim();
    if (path.length === 0) continue;
    files.push(path);
    added += Number.parseInt(cells[0] ?? "", 10) || 0;
    deleted += Number.parseInt(cells[1] ?? "", 10) || 0;
  }
  return { files, added, deleted };
};

export const parseCommitNumstat = (raw: string): ReadonlyMap<string, CommitNumstat> => {
  const stats = new Map<string, CommitNumstat>();
  for (const record of raw.replace(/\r\n/g, "\n").split(FORK_LOG_RECORD_SEPARATOR)) {
    const [sha = "", ...rows] = record.split("\n");
    if (sha.trim().length === 0) continue;
    stats.set(sha.trim(), parseNumstatRows(rows));
  }
  return stats;
};

export const ForkTier = Schema.Literals(["core", "qol", "bugfix"]);
export type ForkTier = typeof ForkTier.Type;

const TIER_ORDER: ReadonlyArray<ForkTier> = ["core", "qol", "bugfix"];

const OptionalTrailer = Schema.optionalKey(Schema.String);

export const ForkCommit = Schema.Struct({
  sha: Schema.String,
  short: Schema.String,
  /** Strict-ISO author date (`%aI`); absent only for a synthesized squash commit. */
  authorDate: OptionalTrailer,
  subject: Schema.String,
  domain: OptionalTrailer,
  tier: OptionalTrailer,
  upstreamable: OptionalTrailer,
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

export class ForkLogExitError extends Schema.TaggedError<ForkLogExitError>()("ForkLogExitError", {
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `git log exited with code ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

export { forkLogArguments, parseForkLog, squashTrailers };

export const parseSquashBody = (subject: string, body: string): ForkCommit => ({
  sha: "squash",
  short: "squash",
  subject,
  ...parseForkTrailers(squashTrailers(body)),
});

const isForkTier = (value: string | undefined): value is ForkTier =>
  value !== undefined && (ForkTier.literals as ReadonlyArray<string>).includes(value);

/**
 * Walk-authored `fixup!` commits are transient: #861 makes them trailer-free by
 * design, and the autosquash in `scripts/fork-sync.ts` folds them into their
 * owners immediately after the delta check runs, so the ledger never sees them
 * as permanent stack members and must not demand trailers from them.
 */
export const dropTransientFixups = (
  commits: ReadonlyArray<ForkCommit>,
): ReadonlyArray<ForkCommit> => commits.filter((commit) => !commit.subject.startsWith("fixup! "));

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
    return problems.map((problem) => ({ short: commit.short, subject: commit.subject, problem }));
  });

export const buildLedger = (
  base: string,
  head: string,
  commits: ReadonlyArray<ForkCommit>,
  retirementLedger: ForkRetirementLedger = EMPTY_RETIREMENT_LEDGER,
): ForkLedger => {
  const stackSubjects = new Set(commits.map((commit) => commit.subject));
  const retired = commits.filter(
    (commit) => retirementDecision(retirementLedger, commit.subject).decision === "retire",
  );
  const active = commits.filter(
    (commit) => retirementDecision(retirementLedger, commit.subject).decision !== "retire",
  );
  return {
    base,
    head,
    commits: active,
    findings: [
      ...collectFindings(active),
      ...retired.map((commit) => ({
        short: commit.short,
        subject: commit.subject,
        problem: "retired but present",
      })),
      // The mirror of "retired but present" (#916): a Kept row names a fork
      // commit the stack must carry, so a subject that walks away without a
      // Retired row fails the check instead of staying green forever.
      ...[...retirementLedger.kept.keys()]
        .filter((subject) => !stackSubjects.has(subject))
        .map((subject) => ({
          short: "ledger",
          subject,
          problem: "kept but absent",
        })),
    ],
    warnings: [],
  };
};

export const buildSquashLedger = (base: string, head: string, body: string): ForkLedger => {
  const commit = parseSquashBody("pull-request body", body);
  return buildLedger(base, head, [commit]);
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
    lines.push("| Tier | Commit | Change | Upstreamable |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of rows) {
      lines.push(
        `| ${row.tier ?? "?"} | \`${row.short}\` | ${escapeCell(row.subject)} | ${row.upstreamable ?? ""} |`,
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
    // the domain sums.
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
// target, measured against the net fork and upstream diffs. --inventory reads
// exactly these numbers.
const collectInventory = Effect.fn("collectForkInventory")(function* (
  target: string,
  head: string,
) {
  const base = yield* resolveInventoryMergeBase(target, head, process.cwd());
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

const resolveInventoryMergeBase = Effect.fn("resolveForkInventoryMergeBase")(function* (
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

const command = Command.make(
  "fork-delta",
  {
    base: Flag.String("base").pipe(
      Flag.withDescription(
        "Base ref; defaults to upstream/main except --squash-body requires it explicitly.",
      ),
      Flag.optional,
    ),
    head: Flag.String("head").pipe(
      Flag.withDescription(
        "Head ref; defaults to HEAD except --squash-body requires it explicitly.",
      ),
      Flag.optional,
    ),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Exit 1 when a fork commit has invalid trailers or is still present after retirement.",
      ),
      Flag.withDefault(false),
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the ledger as JSON instead of Markdown."),
      Flag.withDefault(false),
    ),
    domain: Flag.String("domain").pipe(
      Flag.withDescription("Limit the ledger to one Fork-Domain."),
      Flag.optional,
    ),
    shas: Flag.Boolean("shas").pipe(
      Flag.withDescription(
        "Print one full SHA per line in stack order, for `git cherry-pick` onto upstream.",
      ),
      Flag.withDefault(false),
    ),
    inventory: Flag.Boolean("inventory").pipe(
      Flag.withDescription(
        "Print the per-domain and per-commit delta inventory instead of the ledger.",
      ),
      Flag.withDefault(false),
    ),
    upstream: Flag.String("upstream").pipe(
      Flag.withDescription(
        "With --inventory, the upstream target to compare against (default: upstream/main).",
      ),
      Flag.optional,
    ),
    squashBody: Flag.String("squash-body").pipe(
      Flag.withDescription(
        "With --check, verify the base-to-head squash and the pull-request body's final trailer block.",
      ),
      Flag.optional,
    ),
  },
  ({ base, head, check, json, domain, shas, squashBody, inventory, upstream }) =>
    Effect.gen(function* () {
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
        const ledger = buildSquashLedger(squashBase, squashHead, body);
        for (const finding of ledger.findings) {
          process.stderr.write(`${finding.subject}: ${finding.problem}\n`);
        }
        if (ledger.findings.length > 0) {
          process.stderr.write(
            `failed: the prospective squash is invalid; end the body with Fork-Domain and Fork-Tier (docs/fork/internals/fork-delta.md)\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write("ok: prospective squash carries its fork trailers\n");
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
      const resolvedBase = Option.getOrElse(base, () => "upstream/main");
      const resolvedHead = Option.getOrElse(head, () => "HEAD");
      const read = yield* readForkLog(resolvedBase, resolvedHead);
      // Transient walk fixups stay out of the ledger entirely: trailer rules
      // check the folded stack only.
      const commits = dropTransientFixups(read);
      const retirementLedger = readForkRetirementLedger(process.cwd());
      const full = buildLedger(resolvedBase, resolvedHead, commits, retirementLedger);
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
        const findings = ledger.findings;
        for (const finding of findings) {
          process.stderr.write(`${finding.short} ${finding.subject}: ${finding.problem}\n`);
        }
        if (findings.length > 0) {
          process.stderr.write(`failed: ${findings.length} fork delta problem(s)\n`);
          process.exitCode = 1;
          return;
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
