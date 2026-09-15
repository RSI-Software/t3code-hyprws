// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.
// fork job step 5: authoring guards
// Gate: fork:ci — the authoring guards, computed inside the fork:scan range; a finding fails the scan.

// Authoring guards for `vp run fork:scan`. Each rule names a
// shape a later rebase pays for, at the moment a fork commit creates it:
//
// - upstream-test: the commit adds a fork test block to an upstream-owned test
//   file instead of its `*.fork.test.ts` sibling, or rewrites an upstream
//   assertion in place (a same-size swap nets to zero added blocks, so the
//   removed side is the whole shape).
// - replaced-export: the commit deletes an upstream-owned exported declaration
import { enclosedSupersededTitles, supersededTitlesByPath } from "./lib/fork-supersedes.ts";

// A case title: the first string literal of an `it`/`test`/`effectIt`
// opener, including the dotted effect forms (`it.effect`, `it.layer`).
// Mirrors the additive gate's opener; kept local so this module stays
// runnable without the gate's git runner.
//   and re-declares it, so every later upstream edit to it lands invisibly.
//
// (RSI-Software/t3code-hyprws#1190: smallest form of the old authoring-guard
// cluster; footprint, lockfile, boundary, seam, and reshape rules do not come
// back.) Warnings on commits in the `--since` range fail the scan; historical
// range stays advisory.

export type ScanAuthoringRule = "upstream-test" | "replaced-export";

export interface ScanAuthoringWarning {
  readonly rule: ScanAuthoringRule;
  readonly commit: string;
  readonly domain: string;
  readonly detail: string;
}

export interface ExportDeclaration {
  readonly path: string;
  readonly kind: string;
  readonly name: string;
  readonly line: string;
}

export interface TestBlockHunk {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

export interface CommitPatch {
  readonly removedExports: ReadonlyArray<ExportDeclaration>;
  readonly addedExports: ReadonlyArray<ExportDeclaration>;
  // `it`/`test`/`describe` block openers stay grouped by zero-context diff
  // hunk, so only a nearby removal can identify an addition as a replacement.
  readonly testBlockHunks: ReadonlyArray<TestBlockHunk>;
  // Significant lines the commit takes out of a `*.test.*` file, keyed by that
  // file's path. A rewrite deletes the old assertion and adds the new one, so
  // the removed side is the whole shape: a same-size swap nets to zero added
  // blocks and the counting rule below misses it entirely.
  readonly removedTestLines: ReadonlyMap<string, ReadonlyArray<string>>;
  // Every added/removed content line a commit's patch carries, keyed by path,
  // so the hook guard can classify the seam without parsing diffs again.
  readonly changedLines: ReadonlyMap<
    string,
    { readonly added: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> }
  >;
}

export interface AuthoringGuardCommit {
  readonly sha: string;
  readonly short: string;
  readonly domain: string;
  readonly tier?: string;
  readonly upstreamable?: string;
}

export interface AuthoringGuardInput {
  // Only the commits the caller wants warned about: `--since` narrows a walk
  // of the whole stack to the commits one change introduces.
  readonly commits: ReadonlyArray<AuthoringGuardCommit>;
  readonly filesBySha: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly patchesBySha: ReadonlyMap<string, CommitPatch>;
  // Paths that exist in the upstream base tree. A fork-created file is the
  // repair every one of these rules points at, so it never triggers them.
  readonly upstreamFiles: ReadonlySet<string>;
  // Test ownership follows the selected target, including independent
  // same-path additions.
  readonly upstreamTestFiles: ReadonlySet<string>;
  // The significant lines each touched upstream test file carries in the
  // target tree. A fork commit that deletes a line it added itself — the
  // repair the rule asks for — removes nothing upstream wrote, so only a
  // line in this set is an upstream case being changed. An absent entry
  // refuses every removal, because an unread tree is not evidence that the
  // line was the fork's.
  readonly upstreamTestLines: ReadonlyMap<string, ReadonlySet<string>>;
  // The significant lines each touched upstream file carries in the target
  // tree, for the hook guard's mirror filter (RSI-Software/t3code-hyprws#1207):
  // an added line the target already has is a revert, not a fork insertion.
  // Absent on inputs built before the map existed; the guard then behaves
  // as it always has.
  readonly upstreamLines?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  // The target-tree text of each touched upstream test file, plus the
  // head-tree (scanned-head) text of every fork sibling. Read together,
  // they let the rule exempt a declared-superseded case structurally —
  // by the case's own lines — instead of by whole-file line membership,
  // which cannot tell a shared body line from an upstream one
  // (RSI-Software/t3code-hyprws#1208).
  readonly upstreamTestTexts: ReadonlyMap<string, string>;
  // Head-tree text for count-aware removal checks: duplicate upstream text
  // survives when the fork only removes its own appended copy.
  readonly headTestTexts?: ReadonlyMap<string, string> | undefined;
  readonly siblingTexts: ReadonlyMap<string, string>;
}

const PATCH_RECORD_SEPARATOR = "\x1e";

export const commitPatchArguments = (shas: ReadonlyArray<string>): ReadonlyArray<string> =>
  [
    "-c",
    "core.quotePath=false",
    "show",
    "--no-ext-diff",
    "--unified=0",
    `--format=${PATCH_RECORD_SEPARATOR}%H`,
    ...shas,
  ] as const;

// A declaration line, not a re-export: `export { x } from "./y"` carries no
// body upstream can extend, so it is not the shape that loses upstream work.
const EXPORT_DECLARATION =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const|let|var|function|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/;

// effectIt is the repository's @effect/vitest alias beside vite-plus/test's it.
const TEST_BLOCK = /^\s*(?:it|test|describe|effectIt)\s*(?:\.[\w$]+)*\s*(?:<[^>]*>)?\s*[(`]/;

const diffPath = (value: string): string | null => {
  const target = value.trim();
  return target === "/dev/null" ? null : target.replace(/^[ab]\//, "");
};

// Blank lines and comment-only lines carry no assertion, so removing one is
// not a rewrite of upstream intent. Everything else in a test file is.
const isSignificant = (content: string): boolean => {
  const trimmed = content.trim();
  return (
    trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("*") && trimmed !== "/*"
  );
};

/** The lines of an upstream test file that a removal can be measured against. */
export const significantTestLines = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .split("\n")
      .filter(isSignificant)
      .map((line) => line.trim()),
  );

export const parseCommitPatches = (raw: string): ReadonlyMap<string, CommitPatch> => {
  const patches = new Map<string, CommitPatch>();
  for (const record of raw.replace(/\r\n/g, "\n").split(PATCH_RECORD_SEPARATOR)) {
    const [header = "", ...lines] = record.split("\n");
    const sha = header.trim();
    if (sha.length === 0) continue;
    const removedExports: Array<ExportDeclaration> = [];
    const addedExports: Array<ExportDeclaration> = [];
    const testBlockHunks: Array<TestBlockHunk> = [];
    const removedTestLines = new Map<string, Array<string>>();
    const addedLines = new Map<string, Array<string>>();
    const removedLines = new Map<string, Array<string>>();
    // A deletion writes `+++ /dev/null`, so removals are attributed to the
    // source side and additions to the target side rather than to one path.
    let sourcePath: string | null = null;
    let targetPath: string | null = null;
    let hunkAddedTestBlocks = 0;
    let hunkRemovedTestBlocks = 0;
    const flushTestBlockHunk = () => {
      const path = targetPath ?? sourcePath;
      if (path !== null && (hunkAddedTestBlocks > 0 || hunkRemovedTestBlocks > 0)) {
        testBlockHunks.push({ path, added: hunkAddedTestBlocks, removed: hunkRemovedTestBlocks });
      }
      hunkAddedTestBlocks = 0;
      hunkRemovedTestBlocks = 0;
    };
    for (const line of lines) {
      if (line.startsWith("--- ")) {
        flushTestBlockHunk();
        sourcePath = diffPath(line.slice(4));
        continue;
      }
      if (line.startsWith("+++ ")) {
        targetPath = diffPath(line.slice(4));
        continue;
      }
      if (line.startsWith("@@")) {
        flushTestBlockHunk();
        continue;
      }
      const added = line.startsWith("+");
      const removed = !added && line.startsWith("-");
      if (!added && !removed) continue;
      const path = added ? targetPath : sourcePath;
      if (path === null) continue;
      const content = line.slice(1);
      const side = added ? addedLines : removedLines;
      const held = side.get(path);
      if (held === undefined) side.set(path, [content]);
      else held.push(content);
      if (!added && TEST_FILE.test(path) && !FORK_TEST_FILE.test(path) && isSignificant(content)) {
        const heldLines = removedTestLines.get(path) ?? [];
        heldLines.push(content.trim());
        removedTestLines.set(path, heldLines);
      }
      const declaration = EXPORT_DECLARATION.exec(content);
      if (declaration !== null) {
        (added ? addedExports : removedExports).push({
          path,
          kind: declaration[1] ?? "",
          name: declaration[2] ?? "",
          line: content.trim(),
        });
      }
      if (TEST_BLOCK.test(content)) {
        if (added) hunkAddedTestBlocks += 1;
        else hunkRemovedTestBlocks += 1;
      }
    }
    flushTestBlockHunk();
    const changedLines = new Map<
      string,
      { readonly added: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> }
    >();
    for (const path of new Set([...addedLines.keys(), ...removedLines.keys()]))
      changedLines.set(path, {
        added: addedLines.get(path) ?? [],
        removed: removedLines.get(path) ?? [],
      });
    patches.set(sha, {
      removedExports,
      addedExports,
      testBlockHunks,
      removedTestLines,
      changedLines,
    });
  }
  return patches;
};

export const TEST_FILE = /\.test\.tsx?$/;
const FORK_TEST_FILE = /\.fork\.test\.tsx?$/;

const TITLE_OF =
  /^\s*(?:it|test|effectIt)\s*(?:\.[\w$]+)*\s*(?:<[^>]*>)?\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/;

/** Trimmed, without blank and comment-only lines: the case-body lines the rule counts. */
const significant = (content: string): boolean => {
  const trimmed = content.trim();
  return (
    trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("*") && trimmed !== "/*"
  );
};

const significantLines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .filter((line) => significant(line))
    .map((line) => line.trim());

/**
 * The significant lines of one named case in the target-tree text: the
 * opener line through the next case opener. Structural, so a fork case
 * that kept the body of the case it replaced exempts by its own case,
 * never by whole-file line membership (RSI-Software/t3code-hyprws#1208).
 */
const caseLines = (text: string, title: string): ReadonlySet<string> => {
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
  return new Set(significantLines(started.join("\n")));
};

/**
 * The target-tree lines of every case the scanned head's sibling declares
 * as superseded for one upstream path. Empty unless the sibling both
 * declares the case and carries a replacement test case — a bare
 * declaration exempts nothing (RSI-Software/t3code-hyprws#1208).
 */
const declaredSupersededLines = (input: AuthoringGuardInput, path: string): ReadonlySet<string> => {
  const upstreamText = input.upstreamTestTexts.get(path);
  if (upstreamText === undefined) return new Set();
  const siblingText = input.siblingTexts.get(forkTestSibling(path));
  if (siblingText === undefined) return new Set();
  const lines = new Set<string>();
  // One excusal per documented sibling case, mirroring the additive gate:
  // five declarations stacked before one case strip one case's lines.
  // A declaration after the last case strips nothing (RSI-Software/t3code-hyprws#1208).
  const enclosed = enclosedSupersededTitles(siblingText, path);
  const declared = new Set(
    supersededTitlesByPath(siblingText, path)
      .filter((entry) => entry.hasReplacement)
      .map((entry) => entry.title),
  );
  for (const title of enclosed) {
    if (!declared.has(title)) continue;
    for (const line of caseLines(upstreamText, title)) lines.add(line);
  }
  return lines;
};

export const forkTestSibling = (path: string): string =>
  path.replace(/\.test\.(tsx?)$/, ".fork.test.$1");

const EMPTY_PATCH: CommitPatch = {
  removedExports: [],
  addedExports: [],
  testBlockHunks: [],
  removedTestLines: new Map(),
  changedLines: new Map(),
};

export const collectAuthoringWarnings = (
  input: AuthoringGuardInput,
): ReadonlyArray<ScanAuthoringWarning> => {
  const warnings: Array<ScanAuthoringWarning> = [];

  for (const commit of input.commits) {
    const patch = input.patchesBySha.get(commit.sha) ?? EMPTY_PATCH;
    const found: Array<ScanAuthoringWarning> = [];
    const warn = (rule: ScanAuthoringRule, detail: string) => {
      found.push({ rule, commit: commit.short, domain: commit.domain, detail });
    };

    const appendedTestBlocks = new Map<string, number>();
    for (const hunk of patch.testBlockHunks) {
      const count = Math.max(0, hunk.added - hunk.removed);
      if (count === 0) continue;
      appendedTestBlocks.set(hunk.path, (appendedTestBlocks.get(hunk.path) ?? 0) + count);
    }
    for (const [path, count] of [...appendedTestBlocks].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!input.upstreamTestFiles.has(path)) continue;
      if (!TEST_FILE.test(path) || FORK_TEST_FILE.test(path)) continue;
      warn(
        "upstream-test",
        `${path} gains ${count} fork test block(s); move them to ${forkTestSibling(path)}`,
      );
    }
    // A fork commit may only append to an upstream test file. The counting
    // rule above sees a gained block; it never sees an assertion rewritten
    // in place, which is a removal on the source side and an addition of the
    // same size on the target side. The removed side alone is the whole
    // shape, so refuse on it and let the sibling carry the fork's case.
    // A declared-superseded case is exempted structurally: the target-tree
    // lines of each case the sibling declares for this path are stripped
    // before membership is tested, so a shared body line the fork kept
    // from the case it replaced does not count as an upstream removal
    // (RSI-Software/t3code-hyprws#1208). The declaration alone buys
    // nothing: the sibling must carry a replacement case.
    for (const [path, lines] of [...patch.removedTestLines].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!input.upstreamTestFiles.has(path)) continue;
      if (!TEST_FILE.test(path) || FORK_TEST_FILE.test(path)) continue;
      const upstreamLines = input.upstreamTestLines.get(path);
      const targetText = input.upstreamTestTexts.get(path);
      const headText = input.headTestTexts?.get(path);
      const occurrences = (text: string, line: string) =>
        significantLines(text).filter((candidate) => candidate === line).length;
      const upstream =
        upstreamLines === undefined
          ? lines
          : lines.filter(
              (line) =>
                upstreamLines.has(line) &&
                (targetText === undefined ||
                  headText === undefined ||
                  occurrences(headText, line) < occurrences(targetText, line)),
            );
      const declared = declaredSupersededLines(input, path);
      const undeclared =
        declared.size === 0 ? upstream : upstream.filter((line) => !declared.has(line));
      if (undeclared.length === 0) continue;
      const first = undeclared[0] ?? "";
      warn(
        "upstream-test",
        `${path} changes or removes ${undeclared.length} upstream test line(s) (first: ${first}); a fork commit may only append to an upstream test file, so move the changed case to ${forkTestSibling(path)} and restore the upstream one`,
      );
    }

    // The re-declaration is matched by name across the whole commit: moving
    // an upstream declaration into a fork-owned file is the common form of
    // this loss, and it leaves the upstream declaration deleted just the same.
    const reported = new Set<string>();
    for (const removed of patch.removedExports) {
      if (!input.upstreamFiles.has(removed.path)) continue;
      const targetLines = input.upstreamLines?.get(removed.path);
      if (targetLines !== undefined && !targetLines.has(removed.line)) continue;
      const key = `${removed.path}${removed.name}`;
      if (reported.has(key)) continue;
      const readded = patch.addedExports.find((added) => added.name === removed.name);
      if (readded === undefined) continue;
      reported.add(key);
      warn(
        "replaced-export",
        `${removed.kind} ${removed.name} is deleted from ${removed.path} and re-declared in ${readded.path}; extend it from a fork-owned sibling and leave the upstream declaration in place`,
      );
    }

    warnings.push(...found.toSorted((left, right) => left.rule.localeCompare(right.rule)));
  }

  return warnings;
};

export const renderAuthoringWarnings = (
  warnings: ReadonlyArray<ScanAuthoringWarning>,
): ReadonlyArray<string> => {
  if (warnings.length === 0) return [];
  const counts = (["upstream-test", "replaced-export"] as const)
    .map((rule) => [rule, warnings.filter((warning) => warning.rule === rule).length] as const)
    .filter(([, count]) => count > 0)
    .map(([rule, count]) => `${rule}: ${count}`)
    .join(", ");
  return [
    "",
    `Authoring guards, ${warnings.length} refusal(s) (${counts}):`,
    ...warnings.map(
      (warning) =>
        `  REFUSE  ${warning.rule}  ${warning.commit}  ${warning.domain}  ${warning.detail}`,
    ),
  ];
};
