// The baseline for the upstream-test append-only rule. The fork already edits 56 upstream test
// files in place, and a rule that refuses every one of them on the first commit that touches an
// unrelated line is a rule nobody can run. The sweep in `docs/internals/fork-test-divergence.md`
// already names those files with their class and their owning commit, so it is the allow-list
// itself rather than a second list beside it: a file leaves the baseline by leaving that table,
// which is the same edit that records the migration (RSI-Software/t3code-hyprws#697).

/** The tracked sweep the baseline is read from. */
export const TEST_DIVERGENCE_REPORT = "docs/internals/fork-test-divergence.md";

/**
 * The heading of the one table that is the baseline. The report carries three other lists of
 * backticked paths — the per-class prose rows and the fork-authored files missing the
 * `*.fork.test` suffix — and none of them is a licence to rewrite an upstream assertion.
 */
const DEBT_SECTION = /^##\s+Upstream test files edited in place\b/;

const HEADING = /^##\s/;

/** A table row's first cell, when it is a backticked path: `| `a/b.test.ts` | +1 / −0 | append |`. */
const ROW_PATH = /^\|\s*`([^`]+)`\s*\|/;

/**
 * The files the append-only rule tolerates, read from the sweep's own table. An unparseable or
 * absent report yields an empty baseline, which refuses more than it should rather than less: a
 * missing allow-list must never read as a licence.
 */
export const parseTestDivergenceDebt = (markdown: string): ReadonlySet<string> => {
  const paths = new Set<string>();
  let inSection = false;
  for (const line of markdown.split("\n")) {
    if (HEADING.test(line)) {
      inSection = DEBT_SECTION.test(line);
      continue;
    }
    if (!inSection) continue;
    const path = ROW_PATH.exec(line)?.[1];
    if (path !== undefined) paths.add(path);
  }
  return paths;
};
