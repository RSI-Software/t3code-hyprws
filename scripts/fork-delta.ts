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

const RECORD_SEPARATOR = "";
const FIELD_SEPARATOR = "";

// `--reverse` keeps stack order: oldest fork commit first, closest to upstream.
export const forkLogArguments = (base: string, head: string) =>
  [
    "log",
    "--reverse",
    `--format=%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%(trailers:unfold,only)${RECORD_SEPARATOR}`,
    `${base}..${head}`,
  ] as const;

const readTrailer = (trailers: string, key: string): string | undefined => {
  for (const line of trailers.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== key.toLowerCase()) continue;
    const value = line.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
};

export const parseForkLog = (raw: string): ReadonlyArray<ForkCommit> =>
  raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = "", short = "", subject = "", trailers = ""] = record.split(FIELD_SEPARATOR);
      const domain = readTrailer(trailers, "Fork-Domain");
      const tier = readTrailer(trailers, "Fork-Tier");
      const upstreamable = readTrailer(trailers, "Fork-Upstreamable");
      return {
        sha,
        short,
        subject,
        ...(domain === undefined ? {} : { domain }),
        ...(tier === undefined ? {} : { tier }),
        ...(upstreamable === undefined ? {} : { upstreamable }),
      };
    });

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

export const parseSquashBody = (subject: string, body: string): ForkCommit => {
  const trailers = squashTrailers(body);
  const domain = readTrailer(trailers, "Fork-Domain");
  const tier = readTrailer(trailers, "Fork-Tier");
  const upstreamable = readTrailer(trailers, "Fork-Upstreamable");
  return {
    sha: "squash",
    short: "squash",
    subject,
    ...(domain === undefined ? {} : { domain }),
    ...(tier === undefined ? {} : { tier }),
    ...(upstreamable === undefined ? {} : { upstreamable }),
  };
};

const isForkTier = (value: string | undefined): value is ForkTier =>
  value !== undefined && (ForkTier.literals as ReadonlyArray<string>).includes(value);

export const collectFindings = (commits: ReadonlyArray<ForkCommit>): ReadonlyArray<ForkFinding> =>
  commits.flatMap((commit) => {
    const problems: Array<string> = [];
    if (commit.domain === undefined) problems.push("missing Fork-Domain");
    if (commit.tier === undefined) problems.push("missing Fork-Tier");
    else if (!isForkTier(commit.tier)) {
      problems.push(
        `unknown Fork-Tier "${commit.tier}" (expected ${ForkTier.literals.join(", ")})`,
      );
    }
    if (commit.tier === "bugfix" && commit.upstreamable === undefined) {
      problems.push("bugfix without Fork-Upstreamable");
    }
    return problems.map((problem) => ({ short: commit.short, subject: commit.subject, problem }));
  });

export const buildLedger = (
  base: string,
  head: string,
  commits: ReadonlyArray<ForkCommit>,
): ForkLedger => ({ base, head, commits, findings: collectFindings(commits) });

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
    lines.push("| --- | --- | --- | --- |");
    for (const row of rows) {
      lines.push(
        `| ${row.tier ?? "?"} | \`${row.short}\` | ${escapeCell(row.subject)} | ${row.upstreamable ?? ""} |`,
      );
    }
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

export const readForkLog = Effect.fn("readForkLog")(function* (
  base: string,
  head: string,
  cwd = process.cwd(),
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(ChildProcess.make("git", forkLogArguments(base, head), { cwd }))
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
  if (exitCode !== 0) {
    return yield* new ForkLogExitError({ exitCode, stderr });
  }
  return parseForkLog(stdout);
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
      Flag.withDescription("Exit 1 when any fork commit lacks a valid Fork-Domain or Fork-Tier."),
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
      const full = buildLedger(base, head, yield* readForkLog(base, head));
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
        for (const finding of ledger.findings) {
          process.stderr.write(`${finding.short} ${finding.subject}: ${finding.problem}\n`);
        }
        if (ledger.findings.length > 0) {
          process.stderr.write(`failed: ${ledger.findings.length} trailer problem(s)\n`);
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
