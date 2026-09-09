// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type CwdCommandRunner as CommandRunner } from "./fork-command.ts";

/**
 * The whole-tree half of the fork's additive doctrine. The per-seam check in
 * `fork-conflict-outcomes.ts` decides one resolution; this module decides the finished replay: the
 * walk's own tree must be a pure addition on top of the upstream tag it replayed onto. The checks
 * are pure Git reads; the mechanical repairs below them are the only writers, and what they
 * rewrite is committed by the walk itself as the `additive` repair commit
 * (RSI-Software/t3code-hyprws#661).
 *
 * The four checks, in the order a maintainer applies them:
 *
 * 1. every upstream file still exists in the replayed tree;
 * 2. migration numbering is intact: every upstream migration keeps its name, and no two live
 *    migrations share a number;
 * 3. every upstream test file exists, is not shrunk, and gains no `.skip`/`.todo`/`.only`;
 * 4. no hunk upstream deleted between the two bases came back through a clean-applying fork
 *    commit — the drift shape no conflict can surface.
 */
export type AdditiveCheck = "files" | "migrations" | "tests" | "readded";

export interface AdditiveFinding {
  readonly check: AdditiveCheck;
  readonly path: string;
  readonly detail: string;
  /** Check `tests`: the compared declaration counts on the upstream and replayed sides. */
  readonly upstream?: number;
  readonly head?: number;
  /** Check `migrations`: the live migration the finding's file shares a number with. */
  readonly collidesWith?: string;
  /** Check `readded`: the significant lines of the upstream-deleted hunks the replay put back. */
  readonly lines?: ReadonlyArray<string>;
}

export interface AdditiveTrees {
  /** The target upstream tag tree the stack was replayed onto. */
  readonly target: string;
  /** The upstream base the stack sat on before the walk. */
  readonly previous: string;
}

const CHECK_SCOPES = ["apps", "packages", "scripts"] as const;

/**
 * Every git call the check makes inside the rehearsal lane carries the walk's comment-char
 * guard, the same invariant every other rehearsal call in `fork-sync` keeps.
 */
const COMMENT_ARGS = ["-c", "core.commentChar=auto"] as const;
const COMMENT_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.commentChar",
  GIT_CONFIG_VALUE_0: "auto",
} as const;

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
  const result = runner.run("git", [...COMMENT_ARGS, ...args], worktree, undefined, COMMENT_ENV);
  if (result.status !== 0 || result.error !== undefined) return null;
  return result.stdout;
};

const showTree = (
  runner: CommandRunner,
  worktree: string,
  tree: string,
  path: string,
): string | null => {
  const result = runner.run(
    "git",
    [...COMMENT_ARGS, "show", `${tree}:${path}`],
    worktree,
    undefined,
    COMMENT_ENV,
  );
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
  if (out === null) throw new Error(`additive check cannot read the tree of ${tree}`);
  return out.split("\0").filter((path) => path !== "" && !isIgnoredPath(path));
};

// 1. Upstream files present.

const missingUpstreamFiles = (
  runner: CommandRunner,
  worktree: string,
  target: string,
): ReadonlyArray<AdditiveFinding> => {
  const deleted = gitOut(runner, worktree, [
    "diff",
    "--name-status",
    "--no-renames",
    "--diff-filter=D",
    "-z",
    target,
    "HEAD",
    "--",
    ...CHECK_SCOPES,
  ]);
  if (deleted === null)
    throw new Error("additive check cannot diff the replayed tree against upstream");
  const entries = deleted.split("\0");
  const findings: Array<AdditiveFinding> = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const path = entries[index + 1] ?? "";
    if (entries[index] === "D" && path !== "" && !isIgnoredPath(path))
      findings.push({
        check: "files",
        path,
        detail: "upstream file is missing from the replayed tree",
      });
  }
  return findings;
};

// 2. Migration numbering intact.

interface MigrationFile {
  readonly path: string;
  readonly number: string;
  /** `001_Name.test.ts` shares its migration's number by design, so it is not a live migration. */
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
): ReadonlyArray<AdditiveFinding> => {
  const upstream = treeMigrations(runner, worktree, target);
  if (upstream.length === 0) return [];
  const head = treeMigrations(runner, worktree, "HEAD");
  const headPaths = new Set(head.map(({ path }) => path));
  const findings: Array<AdditiveFinding> = [];
  for (const { path } of upstream)
    if (!headPaths.has(path))
      findings.push({
        check: "migrations",
        path,
        detail: "upstream migration is missing from the replayed tree",
      });
  const upstreamLive = new Set(upstream.filter(({ test }) => !test).map(({ path }) => path));
  const byNumber = new Map<string, Array<string>>();
  for (const { path, number, test } of head) {
    if (test) continue;
    const held = byNumber.get(number) ?? [];
    held.push(path);
    byNumber.set(number, held);
  }
  for (const [number, paths] of [...byNumber].sort()) {
    if (paths.length < 2) continue;
    const forkOnly = paths.filter((path) => !upstreamLive.has(path));
    const upstreamOwn = paths.filter((path) => upstreamLive.has(path));
    if (forkOnly.length !== 1) {
      // Upstream shipped its own collision, or two fork migrations share the number: no
      // mechanical fix can tell which one to move.
      for (const path of forkOnly.length > 0 ? forkOnly : paths)
        findings.push({
          check: "migrations",
          path,
          collidesWith: paths.find((candidate) => candidate !== path) ?? "",
          detail: `migration number ${number} is not unique in the replayed tree`,
        });
      continue;
    }
    const other = upstreamOwn[0] ?? paths.find((path) => path !== forkOnly[0]) ?? "";
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

const testFindings = (
  runner: CommandRunner,
  worktree: string,
  target: string,
): ReadonlyArray<AdditiveFinding> => {
  const findings: Array<AdditiveFinding> = [];
  for (const path of treeNames(runner, worktree, target).filter(isTestPath)) {
    const upstreamText = showTree(runner, worktree, target, path);
    if (upstreamText === null) continue;
    const upstreamModifiers = declarationModifiers(upstreamText);
    const upstreamPresent = countPresent(upstreamModifiers);
    const headText = showTree(runner, worktree, "HEAD", path);
    if (headText === null) {
      findings.push({
        check: "tests",
        path,
        upstream: upstreamPresent,
        head: 0,
        detail: "upstream test file is missing from the replayed tree",
      });
      continue;
    }
    const headModifiers = declarationModifiers(headText);
    const headPresent = countPresent(headModifiers);
    if (headPresent < upstreamPresent)
      findings.push({
        check: "tests",
        path,
        upstream: upstreamPresent,
        head: headPresent,
        detail: `test declarations shrunk from ${upstreamPresent} to ${headPresent}`,
      });
    const upstreamRestrictive = countRestrictive(upstreamModifiers);
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

// 4. Nothing upstream removed is back.

/** Significant lines: trimmed, without blank lines and `//`/`*` comment-only lines. */
const isSignificant = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("*");
};

/**
 * A re-added *hunk*, never a re-added token. Matching single lines flags every `}`, `);`, and
 * `<Outlet />` the fork legitimately writes in a file upstream also edited, and the mechanical fix
 * below then deletes that syntax out of a tree that no longer compiles. Only a contiguous run of at
 * least this many significant lines is upstream intent coming back.
 */
const READDED_BLOCK_LINES = 3;

/** Contiguous same-side runs of a diff, trimmed, without blank and comment-only lines. */
const diffBlocks = (diff: string, side: "+" | "-"): ReadonlyArray<ReadonlyArray<string>> => {
  const blocks: Array<Array<string>> = [];
  let run: Array<string> = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith(side) && !raw.startsWith(side.repeat(3))) {
      const line = raw.slice(1);
      if (isSignificant(line)) run.push(line.trim());
      continue;
    }
    if (run.length > 0) blocks.push(run);
    run = [];
  }
  if (run.length > 0) blocks.push(run);
  return blocks;
};

const blockAt = (
  haystack: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
  start: number,
): boolean => needle.every((line, offset) => haystack[start + offset] === line);

const containsBlock = (
  haystack: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
): boolean => {
  for (let start = 0; start + needle.length <= haystack.length; start += 1)
    if (blockAt(haystack, needle, start)) return true;
  return false;
};

const readdedFindings = (
  runner: CommandRunner,
  worktree: string,
  trees: AdditiveTrees,
): ReadonlyArray<AdditiveFinding> => {
  const changed = gitOut(runner, worktree, [
    "diff",
    "--name-only",
    "-z",
    trees.previous,
    trees.target,
    "--",
    ...CHECK_SCOPES,
  ]);
  if (changed === null) throw new Error("additive check cannot diff the two upstream bases");
  const findings: Array<AdditiveFinding> = [];
  for (const path of changed.split("\0").filter((path) => path !== "" && !isIgnoredPath(path))) {
    const upstreamDiff = gitOut(runner, worktree, [
      "diff",
      trees.previous,
      trees.target,
      "--",
      path,
    ]);
    if (upstreamDiff === null) continue;
    const removed = diffBlocks(upstreamDiff, "-").filter(
      (block) => block.length >= READDED_BLOCK_LINES,
    );
    if (removed.length === 0) continue;
    const replayDiff = gitOut(runner, worktree, ["diff", trees.target, "HEAD", "--", path]);
    if (replayDiff === null) continue;
    const added = diffBlocks(replayDiff, "+");
    const back = removed.filter((block) =>
      added.some((candidate) => containsBlock(candidate, block)),
    );
    if (back.length === 0) continue;
    findings.push({
      check: "readded",
      path,
      lines: [...new Set(back.flat())].sort(),
      detail: `re-adds ${back.length} hunk(s) upstream deleted`,
    });
  }
  return findings;
};

/**
 * The walk's own tree against the two upstream trees. Throws only when Git itself cannot answer —
 * a returned finding is always a statement about the tree, never about the tooling.
 */
export const checkAdditive = (
  runner: CommandRunner,
  worktree: string,
  trees: AdditiveTrees,
): ReadonlyArray<AdditiveFinding> => [
  ...missingUpstreamFiles(runner, worktree, trees.target),
  ...migrationFindings(runner, worktree, trees.target),
  ...testFindings(runner, worktree, trees.target),
  ...readdedFindings(runner, worktree, trees),
];

// Mechanical repairs. A fix is what a maintainer would have applied by hand for the same reason;
// anything else is refused and stays on the report as the walk's stop.

export interface AdditiveFixes {
  readonly fixed: ReadonlyArray<AdditiveFinding>;
  /** Findings no mechanical fix may touch — the walk's only remaining additive stop. */
  readonly remaining: ReadonlyArray<AdditiveFinding>;
  /** The worktree paths a fix rewrote, for staging and the repair commit's domain lookup. */
  readonly paths: ReadonlyArray<string>;
}

interface AppliedFix {
  readonly finding: AdditiveFinding;
  readonly paths: ReadonlyArray<string>;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const balancedBraces = (text: string): boolean => text.split("{").length === text.split("}").length;

const dropReaddedLines = (
  runner: CommandRunner,
  worktree: string,
  target: string,
  finding: AdditiveFinding,
): AppliedFix | undefined => {
  const drops = new Set(finding.lines ?? []);
  if (drops.size === 0) return undefined;
  const diff = gitOut(runner, worktree, ["diff", target, "HEAD", "--", finding.path]);
  if (diff === null) return undefined;
  // Only a run the replay added wholly out of the detected hunk goes. A larger run around it is a
  // fork edit the walk cannot separate from the re-add, so it stays a maintainer's call.
  const blocks = diffBlocks(diff, "+").filter(
    (block) => block.length >= READDED_BLOCK_LINES && block.every((line) => drops.has(line)),
  );
  if (blocks.length === 0) return undefined;
  // A removal that dangles a block — unbalanced braces by simple count — is a maintainer's call.
  if (!balancedBraces(blocks.flat().join("\n"))) return undefined;
  let text: string;
  try {
    text = NodeFS.readFileSync(NodePath.join(worktree, finding.path), "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  const trimmed = lines.map((line) => line.trim());
  const removals = new Set<number>();
  for (const block of blocks) {
    let placed = false;
    for (let start = 0; start + block.length <= trimmed.length; start += 1) {
      if (!blockAt(trimmed, block, start)) continue;
      if (Array.from({ length: block.length }, (_, offset) => start + offset).some((index) =>
        removals.has(index),
      ))
        continue;
      for (let offset = 0; offset < block.length; offset += 1) removals.add(start + offset);
      placed = true;
      break;
    }
    // A hunk the walk cannot find intact in the file is one it must not cut around.
    if (!placed) return undefined;
  }
  NodeFS.writeFileSync(
    NodePath.join(worktree, finding.path),
    lines.filter((_, index) => !removals.has(index)).join("\n"),
  );
  return {
    finding: {
      ...finding,
      detail: `removed ${blocks.length} re-added hunk(s) upstream deleted — consider keeping ours`,
    },
    paths: [finding.path],
  };
};

/**
 * Renumber a fork-only migration whose number upstream's own history caught up with: the file
 * (and any sibling sharing its stem) moves past every number in the tree, every reference the
 * grep can reach follows, and a registry that is an ordered list moves the entry after the last
 * one. Anything the transformation cannot pin down exactly once is refused — a half-renumbered
 * registry is worse than a stop.
 */
const renumberForkMigration = (
  runner: CommandRunner,
  worktree: string,
  finding: AdditiveFinding,
): AppliedFix | undefined => {
  const match = MIGRATION_NAME.exec(NodePath.basename(finding.path));
  if (match === null) return undefined;
  const stem = `${match[1] ?? ""}${match[2] ?? ""}`;
  const migrationName = (match[2] ?? "").slice(1).replace(/\.ts$/, "");
  const head = treeMigrations(runner, worktree, "HEAD");
  if (head.length === 0) return undefined;
  const highest = Math.max(...head.map(({ number }) => Number(number)));
  if (!Number.isSafeInteger(highest)) return undefined;
  const nextNumber = String(highest + 1).padStart(3, "0");
  const nextStem = `${nextNumber}${match[2] ?? ""}`;
  // 1. Rename the migration and any sibling that shares its stem.
  const siblings = head
    .filter((file) => NodePath.basename(file.path).startsWith(stem))
    .map((file) => ({
      from: file.path,
      to: NodePath.join(
        NodePath.dirname(file.path),
        `${nextStem}${NodePath.basename(file.path).slice(stem.length)}`,
      ),
    }));
  const own = siblings.find((rename) => rename.from === finding.path);
  if (own === undefined) return undefined;
  try {
    for (const rename of siblings)
      NodeFS.renameSync(NodePath.join(worktree, rename.from), NodePath.join(worktree, rename.to));
  } catch {
    return undefined;
  }
  // 2. Update every reference the grep can reach. A longer name that merely starts with the stem
  // cannot be rewritten safely, so that shape is a refusal instead of a corrupt reference.
  const updated = new Set<string>();
  const grepStem = runner.run(
    "git",
    [...COMMENT_ARGS, "grep", "-l", "-I", "--fixed-strings", stem, "--", ...CHECK_SCOPES],
    worktree,
    undefined,
    COMMENT_ENV,
  );
  if (grepStem.error !== undefined || (grepStem.status !== 0 && grepStem.status !== 1))
    return undefined;
  const stemAmbiguous = new RegExp(`${escapeRegExp(stem)}[A-Za-z0-9_$]`);
  for (const file of grepStem.stdout.split("\n")) {
    const relative = file.trim();
    if (relative === "" || updated.has(relative)) continue;
    let text: string;
    try {
      text = NodeFS.readFileSync(NodePath.join(worktree, relative), "utf8");
    } catch {
      return undefined;
    }
    if (stemAmbiguous.test(text)) return undefined;
    NodeFS.writeFileSync(
      NodePath.join(worktree, relative),
      text.replace(new RegExp(`${escapeRegExp(stem)}(?![A-Za-z0-9_$])`, "g"), nextStem),
    );
    updated.add(relative);
  }
  // A migration whose import nobody rewrote is a dangling reference: the registry is outside
  // grep's reach, which is the stop the brief names, not a fix to half-apply.
  if (updated.size === 0) return undefined;
  // 3. The registry: an ordered list moves the renumbered entry after the last one, renumbering
  // its id and the import binding beside it. The binding is renamed only on the rewritten import
  // line, because in the collision case upstream's own lines still carry the same identifier and
  // a repo-wide rename would take them with it.
  const registryPath = [...updated].find((relative) => {
    try {
      return NodeFS.readFileSync(NodePath.join(worktree, relative), "utf8").includes(
        "migrationEntries",
      );
    } catch {
      return false;
    }
  });
  if (registryPath === undefined) return undefined;
  const text = NodeFS.readFileSync(NodePath.join(worktree, registryPath), "utf8");
  const lines = text.split("\n");
  const entryIndex = lines.findIndex((line) =>
    new RegExp(`^\\s*\\[\\s*\\d+\\s*,\\s*"${escapeRegExp(migrationName)}"\\s*,`).test(line),
  );
  const closingIndex = lines.findLastIndex((line) => /^\];\s*$/.test(line));
  if (entryIndex === -1 || closingIndex === -1 || entryIndex > closingIndex) return undefined;
  const entry = lines[entryIndex] ?? "";
  const binding = /\[\s*\d+\s*,\s*"[^"]*"\s*,\s*([A-Za-z_$][\w$]*)\s*\]/.exec(entry)?.[1];
  if (binding === undefined) return undefined;
  const renumbered = entry
    .replace(/^([\s*]*)\[\s*\d+/, `$1[${Number(nextNumber)}`)
    .replace(binding, `Migration${Number(nextNumber).toString().padStart(4, "0")}`);
  const importIndex = lines.findIndex((line) => line.includes(nextStem));
  if (importIndex !== -1)
    lines[importIndex] = (lines[importIndex] ?? "").replace(
      binding,
      `Migration${Number(nextNumber).toString().padStart(4, "0")}`,
    );
  const moved = lines.toSpliced(entryIndex, 1).toSpliced(closingIndex - 1, 0, renumbered);
  NodeFS.writeFileSync(NodePath.join(worktree, registryPath), moved.join("\n"));
  updated.add(registryPath);
  return {
    finding: { ...finding, path: own.to, detail: `renumbered to ${NodePath.basename(own.to)}` },
    paths: [...siblings.map(({ to }) => to), ...updated],
  };
};

const applyAdditiveFix = (
  runner: CommandRunner,
  worktree: string,
  target: string,
  finding: AdditiveFinding,
): AppliedFix | undefined => {
  const restore = (): AppliedFix | undefined => {
    const result = runner.run(
      "git",
      [...COMMENT_ARGS, "checkout", target, "--", finding.path],
      worktree,
      undefined,
      COMMENT_ENV,
    );
    if (result.status !== 0 || result.error !== undefined) return undefined;
    return { finding, paths: [finding.path] };
  };
  if (finding.check === "files") return restore();
  if (finding.check === "migrations")
    return finding.collidesWith === undefined
      ? restore()
      : renumberForkMigration(runner, worktree, finding);
  // A shrunk upstream test is a human decision; only a wholly missing file restores.
  if (finding.check === "tests") return finding.head === 0 ? restore() : undefined;
  return dropReaddedLines(runner, worktree, target, finding);
};

/**
 * Apply every mechanical fix the findings admit. The refusals come back as `remaining`: a shrunk
 * upstream test and a brace-dangling removal are a maintainer's decision, not the walk's.
 */
export const applyAdditiveFixes = (
  runner: CommandRunner,
  worktree: string,
  target: string,
  findings: ReadonlyArray<AdditiveFinding>,
): AdditiveFixes => {
  const fixed: Array<AdditiveFinding> = [];
  const remaining: Array<AdditiveFinding> = [];
  const paths = new Set<string>();
  for (const finding of findings) {
    const fix = applyAdditiveFix(runner, worktree, target, finding);
    if (fix === undefined) {
      remaining.push(finding);
      continue;
    }
    fixed.push(fix.finding);
    for (const path of fix.paths) paths.add(path);
  }
  return { fixed, remaining, paths: [...paths].sort() };
};
