// @effect-diagnostics nodeBuiltinImport:off - Pure probe logic; git plumbing stays in the command.

import {
  manifestHooksFor,
  resolveTipHookSpans,
  type ForkHooksManifest,
} from "./fork-conflict-outcomes.ts";
import { FORK_HOOKS, parseForkHookMarkers } from "./fork-hooks.ts";

/**
 * The hook-debt probe for `fork:delta --hook-debt`
 * (RSI-Software/t3code-hyprws#1096): per upstream-owned tip-marked file, per
 * manifest key, one verdict at the replayed commit's position in the stack —
 * resolvable, absent, or unprobeable — read with the gate's own
 * `resolveTipHookSpans` so probe and gate agree by construction.
 *
 * Nothing here treats first-touch as truth: the caller orders the campaign by
 * it because it is a cheap proxy for replay position, and the render says so.
 */

export type HookKeyStatus = "resolvable" | "absent" | "unprobeable";

export interface HookDebtKeyRow {
  readonly commitShort: string;
  readonly commitSha: string;
  readonly subject: string;
  readonly path: string;
  readonly key: string;
  readonly status: HookKeyStatus;
  /** Why the verdict is what it is; rendered beside the row it names. */
  readonly reason: string;
}

export interface ReshapeCandidate {
  readonly files: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<{
    readonly short: string;
    readonly subject: string;
  }>;
}

export interface HookDebtReport {
  /** Every probed (commit, path, key) triple, in campaign order. */
  readonly rows: ReadonlyArray<HookDebtKeyRow>;
  /** Commits carrying at least one key that did not resolve, in campaign order. */
  readonly gappedCommits: ReadonlyArray<string>;
  /** Gapped commits grouped by overlapping tip-marked file sets. */
  readonly candidates: ReadonlyArray<ReshapeCandidate>;
  readonly totals: {
    readonly probedKeys: number;
    readonly resolvableKeys: number;
    readonly absentKeys: number;
    readonly unprobeableKeys: number;
    readonly probedCommits: number;
    readonly gappedCommitCount: number;
    readonly candidateCount: number;
  };
}

export const hookDebtPaths = (manifest: ForkHooksManifest = FORK_HOOKS): ReadonlyArray<string> =>
  [...new Set(Object.values(manifest).map(({ path }) => path))].sort();

/**
 * One path's keys at one replayed commit. `commitText` is the commit's blob of
 * the path (`theirs` in the gate's vocabulary) and `tipText` the fork tip's;
 * either may be absent, and the keys it covers say so instead of guessing.
 */
export const probePathHookDebt = (
  path: string,
  manifest: ForkHooksManifest,
  commitText: string | undefined,
  tipText: string | undefined,
): ReadonlyArray<{
  readonly key: string;
  readonly status: HookKeyStatus;
  readonly reason: string;
}> => {
  const entries = manifestHooksFor(path, manifest);
  if (entries.length === 0) return [];
  const verdicts: Array<{ key: string; status: HookKeyStatus; reason: string }> = [];
  if (commitText === undefined) {
    for (const { key } of entries)
      verdicts.push({
        key,
        status: "unprobeable",
        reason: "the path does not exist in this commit's tree",
      });
    return verdicts;
  }
  // An in-file marker wins in the gate, so it wins here too: the replayed
  // commit carries the key itself and no tip overlay is needed.
  const marked = new Set(parseForkHookMarkers(commitText).map(({ key }) => key));
  const resolved = resolveTipHookSpans(
    path,
    { base: "", ours: "", theirs: commitText, ...(tipText === undefined ? {} : { tip: tipText }) },
    manifest,
  );
  for (const { key } of entries) {
    if (marked.has(key)) {
      verdicts.push({
        key,
        status: "resolvable",
        reason: "the commit's own text carries the marker",
      });
      continue;
    }
    if (resolved.spans.has(key)) {
      verdicts.push({
        key,
        status: "resolvable",
        reason: "the tip's span locates the seam in this commit",
      });
      continue;
    }
    if (resolved.ambiguous.includes(key)) {
      verdicts.push({
        key,
        status: "unprobeable",
        reason: "the tip's declaration matches several lines in this commit",
      });
      continue;
    }
    if (resolved.absent.includes(key)) {
      verdicts.push({
        key,
        status: "absent",
        reason: "no matching lines exist at this commit's position",
      });
      continue;
    }
    // The resolver skips keys the tip does not declare; skipping is the fork
    // tip's word that the gate needs no overlay, but the probe still has to
    // name a verdict for the key, and it cannot verify one.
    verdicts.push({
      key,
      status: "unprobeable",
      reason:
        tipText === undefined
          ? "the fork tip has no blob for this path"
          : "the fork tip does not declare this key",
    });
  }
  return verdicts;
};

/** Gapped commits grouped by shared tip-marked files: two commits reshape together when their debt touches the same file. */
export const groupReshapeCandidates = (
  commits: ReadonlyArray<{
    readonly short: string;
    readonly subject: string;
    readonly debtFiles: ReadonlyArray<string>;
  }>,
): ReadonlyArray<ReshapeCandidate> => {
  const parent = commits.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      const root = (parent[current] ?? current) as number;
      current = (parent[root] ?? root) as number;
      parent[index] = current;
    }
    return current;
  };
  const byFile = new Map<string, number>();
  for (const [index, commit] of commits.entries()) {
    for (const file of commit.debtFiles) {
      const first = byFile.get(file);
      if (first === undefined) {
        byFile.set(file, index);
        continue;
      }
      const a = find(index);
      const b = find(first);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<
    number,
    {
      files: Set<string>;
      commits: Array<{ short: string; subject: string; debtFiles: ReadonlyArray<string> }>;
    }
  >();
  for (const [index, commit] of commits.entries()) {
    const root = find(index);
    const group = groups.get(root) ?? { files: new Set<string>(), commits: [] };
    for (const file of commit.debtFiles) group.files.add(file);
    group.commits.push(commit);
    groups.set(root, group);
  }
  return [...groups.values()].map((group) => ({
    files: [...group.files].sort(),
    commits: group.commits.map(({ short, subject }) => ({ short, subject })),
  }));
};

export const buildHookDebtReport = (
  probes: ReadonlyArray<{
    readonly commitShort: string;
    readonly commitSha: string;
    readonly subject: string;
    readonly path: string;
    readonly verdicts: ReadonlyArray<{ key: string; status: HookKeyStatus; reason: string }>;
  }>,
): HookDebtReport => {
  const rows: Array<HookDebtKeyRow> = [];
  for (const probe of probes)
    for (const verdict of probe.verdicts)
      rows.push({
        commitShort: probe.commitShort,
        commitSha: probe.commitSha,
        subject: probe.subject,
        path: probe.path,
        key: verdict.key,
        status: verdict.status,
        reason: verdict.reason,
      });
  const gapped = new Map<string, { short: string; subject: string; files: Set<string> }>();
  for (const row of rows) {
    if (row.status === "resolvable") continue;
    const entry = gapped.get(row.commitSha) ?? {
      short: row.commitShort,
      subject: row.subject,
      files: new Set<string>(),
    };
    entry.files.add(row.path);
    gapped.set(row.commitSha, entry);
  }
  const gappedCommits = [...gapped.values()];
  const candidates = groupReshapeCandidates(
    gappedCommits.map(({ short, subject, files }) => ({
      short,
      subject,
      debtFiles: [...files].sort(),
    })),
  );
  const count = (status: HookKeyStatus): number =>
    rows.filter((row) => row.status === status).length;
  return {
    rows,
    gappedCommits: gappedCommits.map(({ short }) => short),
    candidates,
    totals: {
      probedKeys: rows.length,
      resolvableKeys: count("resolvable"),
      absentKeys: count("absent"),
      unprobeableKeys: count("unprobeable"),
      probedCommits: new Set(rows.map((row) => row.commitSha)).size,
      gappedCommitCount: gappedCommits.length,
      candidateCount: candidates.length,
    },
  };
};

/**
 * Render the probe. Every number carries its counting unit — key probes,
 * commits, candidates — because the campaign mixes all three, and first-touch
 * is named as the ordering proxy it is, never as the replay truth.
 */
export const renderHookDebtReport = (
  report: HookDebtReport,
  position: { readonly label: string; readonly ref: string },
): string => {
  const lines: Array<string> = [];
  lines.push(
    `hook debt at ${position.label} \`${position.ref}\` (first-touch order; a proxy for replay position, not the truth source)`,
    "",
  );
  lines.push(
    `totals: ${report.totals.probedKeys} key probes (${report.totals.resolvableKeys} resolvable keys, ${report.totals.absentKeys} absent keys, ${report.totals.unprobeableKeys} unprobeable keys) across ${report.totals.probedCommits} commits`,
    "",
  );
  lines.push("| Commit | Subject | Path | Key | Verdict | Reason |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of report.rows)
    lines.push(
      `| \`${row.commitShort}\` | ${row.subject} | \`${row.path}\` | \`${row.key}\` | ${row.status} | ${row.reason} |`,
    );
  lines.push("", "## Reshape candidates", "");
  if (report.candidates.length === 0) {
    lines.push("none: 0 gapped commits, so no reshape candidate forms", "");
  } else {
    lines.push(
      `${report.totals.candidateCount} candidates grouping ${report.totals.gappedCommitCount} gapped commits (commits whose debt keys did not all resolve) by overlapping tip-marked file sets:`,
      "",
    );
    for (const [index, candidate] of report.candidates.entries())
      lines.push(
        `${index + 1}. ${candidate.files.map((file) => `\`${file}\``).join(", ")}`,
        ...candidate.commits.map(({ short, subject }) => `   - \`${short}\` ${subject}`),
      );
    lines.push("");
  }
  return lines.join("\n");
};
