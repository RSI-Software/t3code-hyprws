// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

// Additive gate step (fork:ci step 1): the finished fork tree must be a pure
// Gate: fork:ci — the additive gate, computed inside the fork:scan range; a finding fails the scan.
// addition on top of its upstream base. Checks 1-3 of the old four-check walk
// (RSI-Software/t3code-hyprws#1190): every upstream file still exists, every
// upstream migration keeps its name with no shared number, and every upstream
// test file exists, keeps every significant line, is not shrunk, and gains no
// `.skip`/`.todo`/`.only`. Read-only: git reads only, no repairs, no writers.

import * as NodePath from "node:path";

import type { CwdCommandRunner as CommandRunner } from "./fork-command.ts";
import { enclosedSupersededTitles } from "./fork-supersedes.ts";

export type AdditiveCheck = "files" | "migrations" | "tests";

export interface AdditiveFinding {
  readonly check: AdditiveCheck;
  readonly path: string;
  readonly detail: string;
  /** Check `tests`: the compared declaration counts on the upstream and head sides. */
  readonly upstream?: number;
  readonly head?: number;
  /** Check `migrations`: the live migration the finding's file shares a number with. */
  readonly collidesWith?: string;
  /** Check `tests`: a sample of the upstream test lines the head tree no longer carries. */
  readonly lines?: ReadonlyArray<string>;
}

const CHECK_SCOPES = ["apps", "packages", "scripts"] as const;

const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations";

const MIGRATION_NAME = /^(\d{3})(_.+\.ts)$/;

const isIgnoredPath = (path: string): boolean =>
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock(?:b)?)$/.test(path) ||
  /(?:^|\/)\.repos\//.test(path);

const gitOut = (
  runner: CommandRunner,
  worktree: string,
  args: ReadonlyArray<string>,
): string | null => {
  const result = runner.run("git", args, worktree);
  if (result.status !== 0 || result.error !== undefined) return null;
  return result.stdout;
};

const showTree = (
  runner: CommandRunner,
  worktree: string,
  tree: string,
  path: string,
): string | null => {
  const result = runner.run("git", ["show", `${tree}:${path}`], worktree);
  if (result.status !== 0 || result.error !== undefined) return null;
  return result.stdout;
};

/** The tracked paths a tree holds inside the check's scope, lockfiles and vendored refs excepted. */
const treeNames = (
  runner: CommandRunner,
  worktree: string,
  tree: string,
): ReadonlyArray<string> => {
  const out = gitOut(runner, worktree, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    tree,
    "--",
    ...CHECK_SCOPES,
  ]);
  if (out === null) throw new Error(`additive gate cannot read the tree of ${tree}`);
  return out.split("\0").filter((path) => path !== "" && !isIgnoredPath(path));
};

// 1. Upstream files present.

const missingUpstreamFiles = (
  runner: CommandRunner,
  worktree: string,
  target: string,
  head = "HEAD",
): ReadonlyArray<AdditiveFinding> => {
  const deleted = gitOut(runner, worktree, [
    "diff",
    "--name-status",
    "--no-renames",
    "--diff-filter=D",
    "-z",
    target,
    head,
    "--",
    ...CHECK_SCOPES,
  ]);
  if (deleted === null) throw new Error("additive gate cannot diff the head tree against upstream");
  const entries = deleted.split("\0");
  const findings: Array<AdditiveFinding> = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const path = entries[index + 1] ?? "";
    if (entries[index] === "D" && path !== "" && !isIgnoredPath(path))
      findings.push({
        check: "files",
        path,
        detail: "upstream file is missing from the head tree",
      });
  }
  return findings;
};

// 2. Migration numbering intact.

interface MigrationFile {
  readonly path: string;
  readonly number: string;
  readonly test: boolean;
}

const treeMigrations = (
  runner: CommandRunner,
  worktree: string,
  tree: string,
): ReadonlyArray<MigrationFile> => {
  const out = gitOut(runner, worktree, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    tree,
    "--",
    MIGRATIONS_DIR,
  ]);
  if (out === null) return [];
  return out.split("\0").flatMap((path): MigrationFile[] => {
    if (path === "") return [];
    const name = NodePath.basename(path);
    const match = MIGRATION_NAME.exec(name);
    if (match === null) return [];
    return [{ path, number: match[1] ?? "", test: name.endsWith(".test.ts") }];
  });
};

const migrationFindings = (
  runner: CommandRunner,
  worktree: string,
  target: string,
  headTree = "HEAD",
): ReadonlyArray<AdditiveFinding> => {
  const upstream = treeMigrations(runner, worktree, target);
  if (upstream.length === 0) return [];
  const head = treeMigrations(runner, worktree, headTree);
  const headPaths = new Set(head.map(({ path }) => path));
  const findings: Array<AdditiveFinding> = [];
  for (const { path } of upstream)
    if (!headPaths.has(path))
      findings.push({
        check: "migrations",
        path,
        detail: "upstream migration is missing from the head tree",
      });
  const upstreamPaths = new Set(upstream.filter(({ test }) => !test).map(({ path }) => path));
  const byNumber = new Map<string, Array<string>>();
  for (const { path, number, test } of head) {
    if (test) continue;
    const held = byNumber.get(number) ?? [];
    held.push(path);
    byNumber.set(number, held);
  }
  for (const [number, paths] of [...byNumber].sort()) {
    if (paths.length < 2) continue;
    const forkOnly = paths.filter((path) => !upstreamPaths.has(path));
    if (forkOnly.length !== 1) {
      // Upstream shipped its own collision, or two fork migrations share the
      // number: no mechanical reading can tell which one to move.
      for (const path of forkOnly.length > 0 ? forkOnly : paths)
        findings.push({
          check: "migrations",
          path,
          collidesWith: paths.find((candidate) => candidate !== path) ?? "",
          detail: `migration number ${number} is not unique in the head tree`,
        });
      continue;
    }
    const other = paths.find((path) => path !== forkOnly[0]) ?? "";
    findings.push({
      check: "migrations",
      path: forkOnly[0] ?? "",
      collidesWith: other,
      detail: `migration number ${number} collides with \`${other}\``,
    });
  }
  return findings;
};

// 3. Upstream tests present and not shrunk.

const TEST_DECLARATION = /^\s*(?:it|test|describe|effectIt)((?:\.[A-Za-z]\w*)*)\s*\(/gm;

/** A `.skip`/`.todo` declaration is not a present one; `.only` is restrictive either way. */
const declarationModifiers = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(TEST_DECLARATION)].map((match) => match[1] ?? "");

const countPresent = (modifiers: ReadonlyArray<string>): number =>
  modifiers.filter((modifier) => !/\.(?:skip|todo)\b/.test(modifier)).length;

const countRestrictive = (modifiers: ReadonlyArray<string>): number =>
  modifiers.filter((modifier) => /\.(?:skip|todo|only)\b/.test(modifier)).length;

const isTestPath = (path: string): boolean =>
  path.endsWith(".test.ts") || path.endsWith(".test.tsx");

/** Trimmed, without blank and comment-only lines: what is left is assertion, fixture, or wiring. */
const significantLines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .map((line) => line.trim());

/**
 * Upstream lines the head tree no longer carries, as a multiset difference so
 * a fork that adds a second copy of a line does not pay for the one it removed
 * elsewhere. Declaration counting sees a deleted *case*; this sees a deleted
 * *assertion*.
 */
const lostUpstreamLines = (
  upstream: ReadonlyArray<string>,
  head: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const available = new Map<string, number>();
  for (const line of head) available.set(line, (available.get(line) ?? 0) + 1);
  const lost: Array<string> = [];
  for (const line of upstream) {
    const remaining = available.get(line) ?? 0;
    if (remaining === 0) {
      lost.push(line);
      continue;
    }
    available.set(line, remaining - 1);
  }
  return lost;
};

/** Enough of the loss to recognise the case it came from, without pasting the file into a report. */
const LOST_LINE_SAMPLE = 5;

export const forkTestSibling = (path: string): string =>
  path.replace(/\.test\.(tsx?)$/, ".fork.test.$1");

export const upstreamTestPath = (sibling: string): string =>
  sibling.replace(/\.fork\.test\.(tsx?)$/, ".test.$1");

// The significant lines one upstream case carries: the opener line naming
// the title through the next case opener. Line-based, the way
// `significantLines` is — a case body is what the lost-line multiset counts.
const TITLE_OF =
  /^\s*(?:it|test|effectIt)\s*(?:\.[\w$]+)*\s*(?:<[^>]*>)?\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/;

const caseLines = (text: string, title: string): ReadonlyArray<string> => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const started: Array<string> = [];
  let inside = false;
  for (const line of lines) {
    const current =
      TITLE_OF.exec(line)
        ?.slice(1)
        .find((part) => part !== undefined) ?? null;
    if (current !== null) {
      if (current === title && !inside) {
        inside = true;
        started.push(line.trim());
        continue;
      }
      if (inside) break;
      continue;
    }
    if (inside) started.push(line);
  }
  return significantLines(started.join("\n"));
};

const testFindings = (
  runner: CommandRunner,
  worktree: string,
  target: string,
  upstreamTarget: string,
  head = "HEAD",
): ReadonlyArray<AdditiveFinding> => {
  const findings: Array<AdditiveFinding> = [];
  for (const path of treeNames(runner, worktree, target).filter(isTestPath)) {
    const upstreamText = showTree(runner, worktree, target, path);
    if (upstreamText === null) continue;
    // Lost lines and declaration counts are measured against the upstream
    // target tree, not the since tree: a case the fork added itself (absent
    // upstream) may leave freely — moving a legacy fork case into a
    // `.fork.test.ts` sibling must not read as upstream loss. Only an
    // upstream-carried declaration counts.
    const upstreamBaseText = showTree(runner, worktree, upstreamTarget, path);
    const forkOwned = target !== upstreamTarget && upstreamBaseText === null;
    // A null base text IS the fork-created case: trees.base is the upstream
    // merge base, so every upstream-carried test is in it by construction.
    // A fork-created file is exempt from the deletion, lost-line, and
    // shrink checks below — but NOT from the .skip/.todo/.only marker
    // check, which has no upstream-ownership premise.
    const upstreamCountText = target === upstreamTarget ? upstreamText : (upstreamBaseText ?? "");
    const upstreamCountModifiers = declarationModifiers(upstreamCountText);
    const upstreamPresent = countPresent(upstreamCountModifiers);
    const headText = showTree(runner, worktree, head, path);
    if (headText === null) {
      if (forkOwned) continue;
      findings.push({
        check: "tests",
        path,
        upstream: upstreamPresent,
        head: 0,
        detail: "upstream test file is missing from the head tree",
      });
      continue;
    }
    // Lost lines are measured against the upstream target tree only: a
    // line the fork added itself may leave freely, so moving a legacy
    // fork case into a `.fork.test.ts` sibling is not refused. The old
    // union with the since tree was dead code — the since tree here IS
    // `target`, so its line set could never reject anything carried.
    const upstreamLines = new Set(significantLines(upstreamCountText));
    const headLines = significantLines(headText);
    const carried = significantLines(upstreamText).filter((line) => upstreamLines.has(line));
    const lost = lostUpstreamLines(carried, headLines);
    const siblingText = showTree(runner, worktree, head, forkTestSibling(path));
    const siblingLines = new Set(significantLines(siblingText ?? ""));
    const unmoved = lost.filter((line) => !siblingLines.has(line));
    // A live declaration supersedes rather than contradicts: the upstream
    // case it names may lose its lines and its declarations, because the
    // sibling carries the fork behaviour beside a record of why. Only a
    // named case is excused — a sibling case contradicting without one
    // stays a finding, and the scan's own supersedes findings name it.
    // The exemption is per declaration, resolved by documentation: each
    // declaration must sit immediately before a sibling case, and each
    // documented case excuses exactly one declaration. Five declarations
    // stacked before one case excuse one deletion, never five
    // (RSI-Software/t3code-hyprws#1208).
    // An inversion names a different title than upstream's, so the
    // exemption keys on the declaration, never on a same-titled sibling
    // case.
    const named = enclosedSupersededTitles(siblingText ?? "", path);
    const excused =
      named.length === 0
        ? new Set<string>()
        : new Set(named.flatMap((title) => caseLines(upstreamText, title)));
    const unsuperseded = unmoved.filter((line) => !excused.has(line));
    if (unsuperseded.length > 0)
      findings.push({
        check: "tests",
        path,
        lines: [...new Set(unsuperseded)].sort().slice(0, LOST_LINE_SAMPLE),
        detail: `${unsuperseded.length} upstream test line(s) are gone from the head tree and appear in no ${forkTestSibling(path)} sibling; a fork commit may only move a case to the sibling, never drop it`,
      });
    const headModifiers = declarationModifiers(headText);
    const headPresent = countPresent(headModifiers);
    // A declared-superseded case's behaviour lives in the sibling under a
    // replacement title, so each documented declaration counts as still
    // present — one documented case, one excusal
    // (RSI-Software/t3code-hyprws#1208).
    const present = headPresent + named.length;
    if (present < upstreamPresent)
      findings.push({
        check: "tests",
        path,
        upstream: upstreamPresent,
        head: present,
        detail: `test declarations shrunk from ${upstreamPresent} to ${present}`,
      });
    const upstreamRestrictive = countRestrictive(upstreamCountModifiers);
    const headRestrictive = countRestrictive(headModifiers);
    if (headRestrictive > upstreamRestrictive)
      findings.push({
        check: "tests",
        path,
        upstream: upstreamRestrictive,
        head: headRestrictive,
        detail: `adds ${headRestrictive - upstreamRestrictive} .skip/.todo/.only marker(s) upstream does not carry`,
      });
  }
  return findings;
};

/**
 * The head's own tree against the upstream base tree: files and
 * migrations read against the base (a deleted upstream file is a
 * violation whenever it left), while the tests check diffs the head
 * against the since tree — the trunk tip the change branched from — so
 * only NEW loss fires. Lost-line measurement additionally filters through
 * the base tree: a line the fork added itself may leave freely, so moving
 * a legacy fork case into a `.fork.test.ts` sibling is not refused. A
 * null since (unscoped run) skips the tests check.
 */
export const checkAdditive = (
  runner: CommandRunner,
  worktree: string,
  trees: { readonly base: string; readonly since: string | null },
  options: { head?: string } = {},
): ReadonlyArray<AdditiveFinding> => {
  const head = options.head ?? "HEAD";
  return [
    ...missingUpstreamFiles(runner, worktree, trees.base, head),
    ...migrationFindings(runner, worktree, trees.base, head),
    ...(trees.since === null ? [] : testFindings(runner, worktree, trees.since, trees.base, head)),
  ];
};

export const renderAdditiveFindings = (
  findings: ReadonlyArray<AdditiveFinding>,
): ReadonlyArray<string> =>
  findings.map((finding) => `additive:${finding.check}: ${finding.path}: ${finding.detail}`);
