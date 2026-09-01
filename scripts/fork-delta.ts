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
  forkLogArguments,
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

export class ForkLogProcessError extends Schema.TaggedErrorClass<ForkLogProcessError>()(
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

export class ForkLogExitError extends Schema.TaggedErrorClass<ForkLogExitError>()(
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
        const changed = yield* runGit(
          ["show", "--name-only", "--format=", commit.sha, "--", "packages/contracts/src"],
          cwd,
        );
        if (changed.exitCode !== 0) {
          return yield* new ForkLogExitError({
            exitCode: changed.exitCode,
            stderr: changed.stderr,
          });
        }
        const paths = changed.stdout
          .split("\n")
          .map((path) => path.trim())
          .filter((path) => path.startsWith("packages/contracts/src/"));
        const findings = yield* Effect.forEach(
          paths,
          (path) =>
            Effect.gen(function* () {
              const [before, after] = yield* Effect.all(
                [
                  readRevisionPath(`${commit.sha}^:${path}`, cwd),
                  readRevisionPath(`${commit.sha}:${path}`, cwd),
                ],
                { concurrency: "unbounded" },
              );
              return compareWireShapes(before, after, path);
            }),
          { concurrency: 4 },
        );
        return [commit.sha, findings.flat() as ReadonlyArray<WireShapeFinding>] as const;
      }),
    { concurrency: 4 },
  );
  return new Map(entries);
});

const command = Command.make(
  "fork-delta",
  {
    base: Flag.string("base").pipe(
      Flag.withDescription("Upstream ref the fork stack sits on."),
      Flag.withDefault("upstream/main"),
    ),
    head: Flag.string("head").pipe(
      Flag.withDescription("Fork ref to inventory."),
      Flag.withDefault("HEAD"),
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
    squashBody: Flag.string("squash-body").pipe(
      Flag.withDescription(
        "With --check, verify a pull-request body file ends with the trailer block its squash commit needs.",
      ),
      Flag.optional,
    ),
  },
  ({ base, head, check, json, domain, shas, squashBody }) =>
    Effect.gen(function* () {
      if (Option.isSome(squashBody)) {
        const fileSystem = yield* FileSystem.FileSystem;
        const body = yield* fileSystem.readFileString(squashBody.value);
        const findings = collectFindings([parseSquashBody("pull-request body", body)]);
        for (const finding of findings) {
          process.stderr.write(`${finding.subject}: ${finding.problem}\n`);
        }
        if (findings.length > 0) {
          process.stderr.write(
            `failed: the squash commit would land without a valid trailer block; end the body with Fork-Domain and Fork-Tier (docs/internals/fork-delta.md)\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write("ok: squash body carries its fork trailers\n");
        return;
      }
      const fileSystem = yield* FileSystem.FileSystem;
      const retirementLedger = readForkRetirementLedger(process.cwd());
      const wireBaseline = parseForkWireBaseline(
        yield* fileSystem.readFileString("docs/internals/fork-wire-baseline.md"),
      );
      const commits = yield* readForkLog(base, head);
      const wireFindings = yield* collectWireShapeFindings(commits);
      const full = buildLedger(base, head, commits, retirementLedger, wireFindings, wireBaseline);
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
        for (const finding of ledger.findings) {
          process.stderr.write(`${finding.short} ${finding.subject}: ${finding.problem}\n`);
        }
        if (ledger.findings.length > 0) {
          process.stderr.write(`failed: ${ledger.findings.length} fork delta problem(s)\n`);
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
