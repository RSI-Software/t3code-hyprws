// Authoring guards for `vp run fork:scan`, derived from what the churn ledger
// already charged us for. Each rule names a shape a later rebase pays for, at
// the moment a fork commit creates it rather than three walks later:
//
// - hot-seam: the commit touches a path the churn ledger lists as a hot seam.
// - upstream-test: the commit adds a fork test block to an upstream-owned test
//   file instead of its `*.fork.test.ts` sibling.
// - footprint: one commit spreads over more upstream files than the budget.
// - replaced-export: the commit deletes an upstream-owned exported declaration
//   and re-declares it, so every later upstream edit to it lands invisibly.
// - lockfile: the commit carries a lockfile change.
// - terminal-attachment-boundary: fork retention state grows inside upstream's
//   terminal metadata/index module instead of its fork-owned hook.
//
// Warnings are advisory. `fork:scan --strict` is what turns them fatal, so a
// rule can ship before the stack it describes is clean.

import { hotSeams, parseLedger } from "./fork-churn.ts";

// `#73` spans 12 hunks over 6 files in the v0.0.39-nightly.20260902.1256
// census, the largest footprint the ledger has had to replay by hand.
export const UPSTREAM_FOOTPRINT_BUDGET = 6;

export type ScanWarningRule =
  | "hot-seam"
  | "upstream-test"
  | "footprint"
  | "replaced-export"
  | "lockfile"
  | "terminal-attachment-boundary";

const RULE_ORDER: ReadonlyArray<ScanWarningRule> = [
  "hot-seam",
  "upstream-test",
  "footprint",
  "replaced-export",
  "lockfile",
  "terminal-attachment-boundary",
];

export interface ScanWarning {
  readonly rule: ScanWarningRule;
  readonly commit: string;
  readonly domain: string;
  readonly detail: string;
}

export interface HotSeam {
  readonly walkCount: number;
  readonly worstClass: string;
}

export interface ExportDeclaration {
  readonly path: string;
  readonly kind: string;
  readonly name: string;
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
  readonly terminalAttachmentStateAdded?: boolean;
}

export interface GuardCommit {
  readonly sha: string;
  readonly short: string;
  readonly domain: string;
}

export interface GuardInput {
  // Only the commits the caller wants warned about: `--since` narrows a walk of
  // the whole stack to the commits one change introduces.
  readonly commits: ReadonlyArray<GuardCommit>;
  readonly filesBySha: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly patchesBySha: ReadonlyMap<string, CommitPatch>;
  // Paths that exist in the upstream base tree. A fork-created file is the
  // repair every one of these rules points at, so it never triggers them.
  readonly upstreamFiles: ReadonlySet<string>;
  readonly hotSeams: ReadonlyMap<string, HotSeam>;
}

const PATCH_RECORD_SEPARATOR = "";

export const commitPatchArguments = (shas: ReadonlyArray<string>) =>
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

const TEST_BLOCK = /^\s*(?:it|test|describe)\s*(?:\.[\w$]+)*\s*(?:<[^>]*>)?\s*[(`]/;

const TERMINAL_METADATA_PATH = "apps/web/src/state/terminalSessions.ts";
// Keep the check scoped to added state/effect calls and the old inline state
// declarations. Upstream memoized metadata indexing and the retained hook call
// remain free to evolve without triggering it.
const TERMINAL_ATTACHMENT_STATE =
  /\b(?:useState|useEffect)\s*(?:<[^>]*>)?\s*\(|\b(?:interface|type)\s+RetainedTerminalAttachmentState\b|\b(?:function|const)\s+updateRetainedTerminalAttachment\b/;

const diffPath = (value: string): string | null => {
  const target = value.trim();
  return target === "/dev/null" ? null : target.replace(/^[ab]\//, "");
};

export const parseCommitPatches = (raw: string): ReadonlyMap<string, CommitPatch> => {
  const patches = new Map<string, CommitPatch>();
  for (const record of raw.replace(/\r\n/g, "\n").split(PATCH_RECORD_SEPARATOR)) {
    const [header = "", ...lines] = record.split("\n");
    const sha = header.trim();
    if (sha.length === 0) continue;
    const removedExports: Array<ExportDeclaration> = [];
    const addedExports: Array<ExportDeclaration> = [];
    const testBlockHunks: Array<TestBlockHunk> = [];
    let terminalAttachmentStateAdded = false;
    // A deletion writes `+++ /dev/null`, so removals are attributed to the
    // source side and additions to the target side rather than to one path.
    let sourcePath: string | null = null;
    let targetPath: string | null = null;
    let hunkAddedTestBlocks = 0;
    let hunkRemovedTestBlocks = 0;
    const flushTestBlockHunk = () => {
      const path = targetPath ?? sourcePath;
      if (path !== null && (hunkAddedTestBlocks > 0 || hunkRemovedTestBlocks > 0)) {
        testBlockHunks.push({
          path,
          added: hunkAddedTestBlocks,
          removed: hunkRemovedTestBlocks,
        });
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
      if (!added && !line.startsWith("-")) continue;
      const path = added ? targetPath : sourcePath;
      if (path === null) continue;
      const content = line.slice(1);
      if (added && path === TERMINAL_METADATA_PATH && TERMINAL_ATTACHMENT_STATE.test(content))
        terminalAttachmentStateAdded = true;
      const declaration = EXPORT_DECLARATION.exec(content);
      if (declaration !== null) {
        (added ? addedExports : removedExports).push({
          path,
          kind: declaration[1] ?? "",
          name: declaration[2] ?? "",
        });
      }
      if (TEST_BLOCK.test(content)) {
        if (added) hunkAddedTestBlocks += 1;
        else hunkRemovedTestBlocks += 1;
      }
    }
    flushTestBlockHunk();
    patches.set(sha, {
      removedExports,
      addedExports,
      testBlockHunks,
      ...(terminalAttachmentStateAdded ? { terminalAttachmentStateAdded: true } : {}),
    });
  }
  return patches;
};

export const readHotSeams = (churnLedger: string): ReadonlyMap<string, HotSeam> =>
  new Map(
    hotSeams(parseLedger(churnLedger)).map((seam) => [
      seam.path,
      { walkCount: seam.walkCount, worstClass: seam.worstClass },
    ]),
  );

// `pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, `Cargo.lock`, `uv.lock`.
const LOCKFILE = /(?:^|\/)(?:[^/]*-lock\.[^/.]+|[^/]*\.lock)$/;

const TEST_FILE = /\.test\.tsx?$/;
const FORK_TEST_FILE = /\.fork\.test\.tsx?$/;

// These two upstream test modules build their integration harnesses in file-local
// scope. Importing an exported helper also registers the upstream suites in the
// sibling, while extracting the complete harness would turn a narrow test move
// into a broad, duplicated harness seam. Keep this list exact and evidence-backed
// in fork-development.md.
export const UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS = new Set([
  "apps/desktop/src/window/DesktopWindow.test.ts",
  "apps/server/src/server.test.ts",
]);

export const forkTestSibling = (path: string): string =>
  path.replace(/\.test\.(tsx?)$/, ".fork.test.$1");

const EMPTY_PATCH: CommitPatch = {
  removedExports: [],
  addedExports: [],
  testBlockHunks: [],
};

export const collectScanWarnings = (input: GuardInput): ReadonlyArray<ScanWarning> => {
  const warnings: Array<ScanWarning> = [];

  for (const commit of input.commits) {
    const files = input.filesBySha.get(commit.sha) ?? [];
    const patch = input.patchesBySha.get(commit.sha) ?? EMPTY_PATCH;
    const upstreamTouched = files.filter((path) => input.upstreamFiles.has(path)).toSorted();
    const found: Array<ScanWarning> = [];
    const warn = (rule: ScanWarningRule, detail: string) => {
      found.push({ rule, commit: commit.short, domain: commit.domain, detail });
    };

    if (patch.terminalAttachmentStateAdded) {
      warn(
        "terminal-attachment-boundary",
        `${TERMINAL_METADATA_PATH} gains attachment retention state; keep it in terminalAttachmentRetention.fork.ts and preserve upstream metadata indexing and tests`,
      );
    }

    for (const path of upstreamTouched) {
      const seam = input.hotSeams.get(path);
      if (seam === undefined) continue;
      warn(
        "hot-seam",
        `${path} is a hot seam (${seam.walkCount} walk(s), worst class ${seam.worstClass}); read docs/internals/fork-churn.md before adding to it`,
      );
    }

    const appendedTestBlocks = new Map<string, number>();
    for (const hunk of patch.testBlockHunks) {
      const count = Math.max(0, hunk.added - hunk.removed);
      if (count === 0) continue;
      appendedTestBlocks.set(hunk.path, (appendedTestBlocks.get(hunk.path) ?? 0) + count);
    }
    for (const [path, count] of [...appendedTestBlocks].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!input.upstreamFiles.has(path)) continue;
      if (!TEST_FILE.test(path) || FORK_TEST_FILE.test(path)) continue;
      if (UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS.has(path)) continue;
      warn(
        "upstream-test",
        `${path} gains ${count} fork test block(s); move them to ${forkTestSibling(path)}`,
      );
    }

    if (upstreamTouched.length > UPSTREAM_FOOTPRINT_BUDGET) {
      warn(
        "footprint",
        `${upstreamTouched.length} upstream file(s) in one commit (budget ${UPSTREAM_FOOTPRINT_BUDGET}); prefer one adapter boundary over edits spread across upstream files`,
      );
    }

    // The re-declaration is matched by name across the whole commit: moving an
    // upstream declaration into a fork-owned file is the common form of this
    // loss, and it leaves the upstream declaration deleted just the same.
    const reported = new Set<string>();
    for (const removed of patch.removedExports) {
      if (!input.upstreamFiles.has(removed.path)) continue;
      const key = `${removed.path} ${removed.name}`;
      if (reported.has(key)) continue;
      const readded = patch.addedExports.find((added) => added.name === removed.name);
      if (readded === undefined) continue;
      reported.add(key);
      warn(
        "replaced-export",
        `${removed.kind} ${removed.name} is deleted from ${removed.path} and re-declared in ${readded.path}; extend it from a fork-owned sibling and leave the upstream declaration in place`,
      );
    }

    // No fork domain owns dependency bumps, so there is no trailer that makes a
    // lockfile change expected. Every one warns until a domain claims them: a
    // fork worktree installs with `vp i --frozen-lockfile`, and a real bump is
    // its own commit under the domain that needs the dependency.
    for (const path of files.toSorted()) {
      if (!LOCKFILE.test(path)) continue;
      warn(
        "lockfile",
        `${path} changes in a ${commit.domain} commit; install with \`vp i --frozen-lockfile\` and keep a real dependency change in its own commit`,
      );
    }

    warnings.push(
      ...found.toSorted(
        (left, right) => RULE_ORDER.indexOf(left.rule) - RULE_ORDER.indexOf(right.rule),
      ),
    );
  }

  return warnings;
};

export const renderScanWarnings = (warnings: ReadonlyArray<ScanWarning>): ReadonlyArray<string> => {
  if (warnings.length === 0) return [];
  const counts = RULE_ORDER.map(
    (rule) => [rule, warnings.filter((warning) => warning.rule === rule).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([rule, count]) => `${rule}: ${count}`)
    .join(", ");
  return [
    "",
    `Ledger guards, ${warnings.length} warning(s) (${counts}):`,
    ...warnings.map(
      (warning) =>
        `  WARN  ${warning.rule}  ${warning.commit}  ${warning.domain}  ${warning.detail}`,
    ),
  ];
};
