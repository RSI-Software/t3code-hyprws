// Derive a fork.rewrite-manifest.v1 that folds one or more landed reshape squashes back into
// their originating fork commits, so the existing series-rewrite lane can apply them
// tree-neutrally (RSI-Software/t3code-hyprws#965). Attribution is read-only; the fold itself
// writes only unreferenced blobs (merge-file + hash-object -w) plus the manifest file.
// @effect-diagnostics nodeBuiltinImport:off - Runs outside an Effect runtime; merge-file needs temp files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  parseRewriteManifest,
  REWRITE_MANIFEST_SCHEMA,
  type RewriteEntry,
  type RewriteManifest,
} from "./fork-rewrite-build.ts";

export type FoldGit = (args: ReadonlyArray<string>, input?: string) => string;

export interface FoldRefusal {
  readonly refused: true;
  readonly reasons: ReadonlyArray<string>;
}

export interface DeriveFoldInput {
  readonly git: FoldGit;
  readonly base: string;
  readonly baseTag: string;
  readonly source: string;
  readonly reshapes: ReadonlyArray<string>;
  /** Per-path origin override (`path -> sha`) for paths blame cannot decide. */
  readonly attribute?: ReadonlyMap<string, string>;
  /** Paths that stay in the reshape commit R: never attributed, never refused. */
  readonly leave?: ReadonlySet<string>;
}

interface FoldEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}
interface DiffHunk {
  readonly path: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newCount: number;
  removed: number;
}

const shortSha = (sha: string): string => sha.slice(0, 12);
const toRewriteEntry = (entry: FoldEntry): RewriteEntry => ({
  mode: entry.mode as RewriteEntry["mode"],
  type: entry.type as RewriteEntry["type"],
  oid: entry.oid,
});
const hunkName = (hunk: DiffHunk): string => `${hunk.path}:${hunk.oldStart},+${hunk.newCount}`;
const PROOF_NAMES = ["snapshot-tests", "composition", "test-ownership", "compatibility"] as const;
const NULL_DIGEST = "0".repeat(64);

const entryAt = (git: FoldGit, treeish: string, path: string): FoldEntry | null => {
  const raw = git(["ls-tree", treeish, "--", path]).trim();
  if (raw.length === 0) return null;
  const [meta, name] = raw.split("\t");
  if (name !== path) throw new Error(`ls-tree returned unexpected path: ${name}`);
  const [mode, type, oid] = (meta ?? "").split(" ");
  if (mode === undefined || type === undefined || oid === undefined)
    throw new Error(`unparsable ls-tree output for ${path}`);
  return { mode, type, oid };
};

/**
 * Rebuild only the ancestor chains of the changed paths, reusing untouched subtree OIDs:
 * O(changed paths x depth) Git spawns per slot, not O(all directories). `mktree` without `-w`
 * computes tree IDs; like `hash-object -w` blobs, any objects it does write are unreferenced
 * and gc-safe.
 */
const applyTreeChanges = (
  git: FoldGit,
  treeOid: string,
  changes: ReadonlyMap<string, FoldEntry | null>,
  listings: Map<string, Map<string, { mode: string; type: string; oid: string; name: string }>>,
): string => {
  const direct = new Map<string, Map<string, FoldEntry | null>>();
  const touched = new Set<string>(); // directories needing a rebuild, ancestors included
  for (const [path, entry] of changes) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash + 1);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const rows = direct.get(dir) ?? new Map<string, FoldEntry | null>();
    rows.set(name, entry);
    direct.set(dir, rows);
    touched.add(dir);
    let prefix = dir;
    while (prefix !== "") {
      const trimmed = prefix.slice(0, -1);
      const cut = trimmed.lastIndexOf("/");
      prefix = cut === -1 ? "" : trimmed.slice(0, cut + 1);
      touched.add(prefix);
    }
  }
  const parentOf = (dir: string): string => {
    const trimmed = dir.slice(0, -1);
    const cut = trimmed.lastIndexOf("/");
    return cut === -1 ? "" : trimmed.slice(0, cut + 1);
  };
  const originalMemo = new Map<string, string | null>([["", treeOid]]);
  const listing = (
    oid: string,
  ): Map<string, { mode: string; type: string; oid: string; name: string }> => {
    const known = listings.get(oid);
    if (known !== undefined) return known;
    const rows = new Map<string, { mode: string; type: string; oid: string; name: string }>();
    for (const record of git(["ls-tree", "-z", oid]).split("\0")) {
      if (record.length === 0) continue;
      const tab = record.indexOf("\t");
      const [mode, type, rowOid] = record.slice(0, tab).split(" ");
      rows.set(record.slice(tab + 1), {
        mode: mode ?? "",
        type: type ?? "",
        oid: rowOid ?? "",
        name: record.slice(tab + 1),
      });
    }
    listings.set(oid, rows);
    return rows;
  };
  const originalOid = (dir: string): string | null => {
    const known = originalMemo.get(dir);
    if (known !== undefined) return known;
    const parentOid = originalOid(parentOf(dir));
    if (parentOid === null) {
      originalMemo.set(dir, null);
      return null;
    }
    const name = dir.slice(parentOf(dir).length, -1);
    const row = listing(parentOid).get(name) ?? null;
    const found = row !== null && row.type === "tree" ? row.oid : null;
    originalMemo.set(dir, found);
    return found;
  };
  const rebuiltMemo = new Map<string, string>();
  const rebuild = (dir: string): string => {
    const known = rebuiltMemo.get(dir);
    if (known !== undefined) return known;
    const rows = new Map<string, { mode: string; type: string; oid: string; name: string }>();
    const original = originalOid(dir);
    if (original !== null)
      for (const row of listing(original).values()) rows.set(row.name, { ...row });
    for (const [name, entry] of direct.get(dir) ?? []) {
      if (entry === null) rows.delete(name);
      else rows.set(name, { mode: entry.mode, type: entry.type, oid: entry.oid, name });
    }
    for (const childDir of touched) {
      if (childDir === dir || !childDir.startsWith(dir)) continue;
      if (childDir.slice(dir.length, -1).includes("/")) continue; // not a direct child
      const name = childDir.slice(dir.length, -1);
      rows.set(name, { mode: "040000", type: "tree", oid: rebuild(childDir), name });
    }
    const lines = [...rows.values()]
      .sort((a, b) =>
        Buffer.compare(
          Buffer.from(`${a.name}${a.type === "tree" ? "/" : ""}`),
          Buffer.from(`${b.name}${b.type === "tree" ? "/" : ""}`),
        ),
      )
      .map((row) => `${row.mode} ${row.type} ${row.oid}\t${row.name}`);
    const oid = git(
      ["mktree", "--missing"],
      lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    ).trim();
    rebuiltMemo.set(dir, oid);
    return oid;
  };
  return rebuild("");
};

const blameLines = (
  git: FoldGit,
  rev: string,
  path: string,
  start: number,
  count: number,
): ReadonlyArray<string> => {
  // Porcelain output names every line's origin as a full 40-hex SHA; -l abbreviates boundary
  // commits to fit the caret prefix, so it cannot be parsed reliably.
  const raw = git(["blame", "--porcelain", `-L${start},+${count}`, rev, "--", path]);
  return [...raw.matchAll(/^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/gm)].map((match) => match[1] ?? "");
};
const blameLine = (git: FoldGit, rev: string, path: string, line: number): string | null => {
  let shas: ReadonlyArray<string>;
  try {
    shas = blameLines(git, rev, path, line, 1);
  } catch {
    return null;
  }
  return shas[0] ?? null;
};

/** Parse `git diff old new` into per-file hunks with unified headers only. */
const parseHunks = (diff: string): ReadonlyArray<DiffHunk> => {
  const hunks: DiffHunk[] = [];
  let path: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const name = line.slice(4);
      path = name === "/dev/null" ? path : name.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const name = line.slice(4);
      if (path === null && name !== "/dev/null") path = name.replace(/^b\//, "");
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null && path !== null)
      hunks.push({
        path,
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        removed: 0,
      });
    else if (path !== null && hunks.length > 0 && line.startsWith("-") && !line.startsWith("---"))
      hunks[hunks.length - 1]!.removed += 1;
    if (line.startsWith("diff --git ")) path = null;
  }
  return hunks;
};

/**
 * Attribute every path of `git diff P R` to one originating fork commit. Removed/changed lines
 * blame against P; pure additions take the nearest adjacent blamed line. Per path, every hunk
 * must agree on the origin. Returns refusals instead of guessing.
 */
const attributeReshape = (
  git: FoldGit,
  reshape: string,
  stack: ReadonlySet<string>,
  reshapeSet: ReadonlySet<string>,
  overrides: ReadonlySet<string>,
  leaves: ReadonlySet<string>,
  order: ReadonlyArray<string>,
): { paths: ReadonlyMap<string, string>; refusals: ReadonlyArray<string> } => {
  const parent = git(["rev-parse", `${reshape}^`]).trim();
  const hunks = parseHunks(
    git(["diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", parent, reshape]),
  );
  const byPath = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) {
    const owned = byPath.get(hunk.path) ?? [];
    owned.push(hunk);
    byPath.set(hunk.path, owned);
  }
  const refusals: string[] = [];
  const origins = new Map<string, string>();
  const position = new Map(order.map((sha, index) => [sha, index]));
  for (const [path, owned] of byPath) {
    if (leaves.has(path)) continue; // The path stays in R and is never attributed.
    if (overrides.has(path)) {
      origins.set(path, ""); // An --attribute override names the origin instead.
      continue;
    }
    const candidates = new Set<string>();
    for (const hunk of owned) {
      let origin: string | null = null;
      if (hunk.removed > 0) {
        let shas: ReadonlyArray<string>;
        try {
          shas = blameLines(git, parent, path, hunk.oldStart, Math.max(hunk.oldCount, 1));
        } catch {
          shas = [];
        }
        const unique = [...new Set(shas)];
        if (unique.length === 0) {
          refusals.push(`${hunkName(hunk)} blames to no commit`);
          continue;
        }
        if (unique.length > 1) {
          refusals.push(
            `${hunkName(hunk)} blames to two fork commits: ${unique.map(shortSha).join(", ")}`,
          );
          continue;
        }
        origin = unique[0] ?? null;
      } else {
        const near =
          hunk.oldCount === 0
            ? [hunk.oldStart, hunk.oldStart + 1]
            : [hunk.oldStart, hunk.oldStart + hunk.oldCount - 1];
        for (const line of near) {
          origin = blameLine(git, parent, path, line);
          if (origin !== null) break;
        }
        if (origin === null) {
          refusals.push(`${hunkName(hunk)} has no adjacent fork-blamed context (pure addition)`);
          continue;
        }
      }
      if (origin !== null && !stack.has(origin))
        refusals.push(
          `${hunkName(hunk)} attributes to ${shortSha(origin)}, outside base..source (upstream or older than base)`,
        );
      else if (origin !== null && reshapeSet.has(origin))
        refusals.push(
          `${hunkName(hunk)} attributes to reshape ${shortSha(origin)}; chains fold later, out of scope`,
        );
      else if (origin !== null) candidates.add(origin);
    }
    if (refusals.some((reason) => reason.startsWith(`${hunkName(owned[0]!)} `))) continue;
    if (candidates.size > 1) {
      const latest = [...candidates]
        .sort((left, right) => (position.get(left) ?? -1) - (position.get(right) ?? -1))
        .at(-1)!;
      refusals.push(
        `${path}: hunks attribute to ${[...candidates].map(shortSha).join(", ")}; split the reshape or --attribute ${path}=${shortSha(latest)}`,
      );
    } else if (candidates.size === 1) origins.set(path, [...candidates][0]!);
  }
  return { paths: origins, refusals };
};

/** 3-way blob merge (base = reshape parent, ours = folded slot, theirs = reshape). */
const mergeBlob = (
  git: FoldGit,
  baseOid: string,
  oursOid: string,
  theirsOid: string,
  blobContent: (oid: string) => string,
): string | null => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fold-merge-"));
  try {
    for (const [name, oid] of [
      ["base", baseOid],
      ["ours", oursOid],
      ["theirs", theirsOid],
    ] as const)
      NodeFS.writeFileSync(NodePath.join(directory, name), blobContent(oid));
    let merged: string;
    try {
      merged = git([
        "merge-file",
        "-p",
        NodePath.join(directory, "ours"),
        NodePath.join(directory, "base"),
        NodePath.join(directory, "theirs"),
      ]);
    } catch {
      return null; // conflict
    }
    return git(["hash-object", "-w", "--stdin"], merged).trim();
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

export const deriveFoldManifest = (input: DeriveFoldInput): RewriteManifest | FoldRefusal => {
  const { git, base, baseTag, source } = input;
  const refusals: string[] = [];
  const blobMemo = new Map<string, string>();
  // One traversal carries commit, tree and signature presence; individual rev-parse/cat-file
  // per slot would dominate the spawn budget on long stacks.
  const log = git(["log", "--reverse", "--topo-order", "--format=%H %T %G?", `${base}..${source}`])
    .trim()
    .split("\n")
    .filter(Boolean);
  const commits = log.map((row) => row.split(" ")[0] ?? "");
  const treeOf = new Map(log.map((row) => [row.split(" ")[0] ?? "", row.split(" ")[1] ?? ""]));
  const signed = new Set(
    log
      .filter((row) => row.split(" ")[2] !== undefined && row.split(" ")[2] !== "N")
      .map((row) => row.split(" ")[0] ?? ""),
  );
  if (commits.length === 0) return { refused: true, reasons: ["base..source is empty"] };
  const stack = new Set(commits);
  const reshapes = input.reshapes.map((sha) => git(["rev-parse", `${sha}^{commit}`]).trim());
  const reshapeSet = new Set(reshapes);
  for (const reshape of reshapes)
    if (!stack.has(reshape)) refusals.push(`reshape ${shortSha(reshape)} is not in base..source`);
  if (refusals.length > 0) return { refused: true, reasons: refusals };

  // Per reshape: attribute per path, then propagate a 3-way blob merge through every slot in
  // [O, R). The reshape slot and every slot after it stay untouched; R's diff shrinks to
  // whatever was not folded.
  const subjects = new Map(
    reshapes.map((sha) => [sha, git(["log", "-1", "--format=%s", sha]).trim()]),
  );
  const changesBySlot = new Map<
    string,
    Map<string, { before: FoldEntry | null; after: FoldEntry | null; reason: string }>
  >();
  const blobContent = (oid: string): string => {
    const known = blobMemo.get(oid);
    if (known !== undefined) return known;
    const content = git(["cat-file", "blob", oid]);
    blobMemo.set(oid, content);
    return content;
  };
  const listings = new Map<
    string,
    Map<string, { mode: string; type: string; oid: string; name: string }>
  >();
  for (const reshape of reshapes) {
    const parent = git(["rev-parse", `${reshape}^`]).trim();
    const belowReshape = new Set(
      git(["rev-list", `${base}..${parent}`])
        .trim()
        .split("\n")
        .filter(Boolean),
    );
    const overrides = new Set([...(input.attribute?.keys() ?? [])]);
    const { paths, refusals: pathRefusals } = attributeReshape(
      git,
      reshape,
      stack,
      reshapeSet,
      overrides,
      input.leave ?? new Set(),
      commits,
    );
    refusals.push(...pathRefusals);
    const parentTree = `${parent}^{tree}`;
    const reshapeTree = `${reshape}^{tree}`;
    for (const [path, blamed] of paths) {
      const override = input.attribute?.get(path);
      let origin = override ?? blamed;
      if (override !== undefined) origin = git(["rev-parse", `${override}^{commit}`]).trim();
      if (origin.length === 0) continue; // Overridden path without an --attribute value.
      if (override !== undefined) {
        if (!belowReshape.has(origin) || reshapeSet.has(origin))
          refusals.push(
            `${path}: --attribute ${shortSha(override)} is not in base..${shortSha(reshape)}^ or is a reshape`,
          );
      }
      const start = commits.indexOf(origin);
      const end = commits.indexOf(reshape);
      if (start < 0 || end < 0)
        refusals.push(`${path}: origin ${shortSha(origin)} is not in base..source`);
      if (refusals.length > 0) continue;
      const parentBlob = entryAt(git, parentTree, path);
      const reshapeBlob = entryAt(git, reshapeTree, path);
      if (parentBlob === null && reshapeBlob === null) continue;
      for (let index = start; index < end; index++) {
        const slotCommit = commits[index]!;
        const slotChanges =
          changesBySlot.get(slotCommit) ??
          new Map<string, { before: FoldEntry | null; after: FoldEntry | null; reason: string }>();
        if (slotChanges.has(path)) {
          refusals.push(`${path}: already folded at ${shortSha(slotCommit)} by an earlier reshape`);
          continue;
        }
        const before = entryAt(git, `${slotCommit}^{tree}`, path);
        let after: FoldEntry | null;
        if (parentBlob === null)
          after = reshapeBlob; // R created the path: every slot takes R's blob.
        else if (before === null)
          after = reshapeBlob; // Absent at C, present at R: R's blob.
        else if (reshapeBlob === null)
          after = null; // R deleted the path: the deletion propagates.
        else if (before.oid === reshapeBlob.oid)
          continue; // Already folded here.
        else if (before.oid === parentBlob.oid)
          after = reshapeBlob; // ours == base: the merge reproduces theirs.
        else {
          const merged = mergeBlob(git, parentBlob.oid, before.oid, reshapeBlob.oid, blobContent);
          if (merged === null) {
            refusals.push(`${path}: fold conflicts at ${shortSha(slotCommit)}`);
            continue;
          }
          if (merged === before.oid) continue; // The merge reproduces C's blob: nothing to fold.
          after = { mode: before.mode, type: "blob", oid: merged };
        }
        slotChanges.set(path, {
          before,
          after,
          reason: `fold ${shortSha(reshape)}: ${subjects.get(reshape) ?? ""}`,
        });
        changesBySlot.set(slotCommit, slotChanges);
      }
    }
  }
  if (refusals.length > 0) return { refused: true, reasons: refusals };

  const slots = commits.map((commit) => {
    const tree = treeOf.get(commit) ?? "";
    const changes = changesBySlot.get(commit);
    if (changes === undefined)
      return {
        commit,
        tree,
        resultTree: tree,
        readSet: [] as Array<{ path: string; entry: RewriteEntry | null }>,
        changes: [] as Array<{
          path: string;
          before: RewriteEntry | null;
          after: RewriteEntry | null;
          reason: string;
        }>,
      };
    const snapshot = new Map<string, FoldEntry | null>(
      [...changes].map(([path, change]) => [path, change.after]),
    );
    return {
      commit,
      tree,
      resultTree: applyTreeChanges(git, tree, snapshot, listings),
      readSet: [...changes].map(([path, change]) => ({
        path,
        entry: change.before === null ? null : toRewriteEntry(change.before),
      })),
      changes: [...changes].map(([path, change]) => ({
        path,
        before: change.before === null ? null : toRewriteEntry(change.before),
        after: change.after === null ? null : toRewriteEntry(change.after),
        reason: change.reason,
      })),
    };
  });
  const changedSlots = slots.filter((slot) => slot.changes.length > 0).length;
  const removedSignatures = commits.filter((commit) => signed.has(commit)).length;

  const manifest: RewriteManifest = {
    schema: REWRITE_MANIFEST_SCHEMA,
    source: git(["rev-parse", `${source}^{commit}`]).trim(),
    sourceTree: git(["rev-parse", `${source}^{tree}`]).trim(),
    base: git(["rev-parse", `${base}^{commit}`]).trim(),
    baseTag,
    proofs: PROOF_NAMES.map((name) => ({
      name,
      artifact: `.dump/runs/965-fold-proofs/${name}.TODO.json`,
      sha256: NULL_DIGEST,
    })),
    expected: {
      changedSlots,
      unchangedSlots: slots.length - changedSlots,
      removedSignatures,
    },
    unresolved: [],
    slots: slots.map((slot) => ({
      commit: slot.commit,
      tree: slot.tree,
      resultTree: slot.resultTree,
      readSet: slot.readSet,
      changes: slot.changes,
    })),
  };
  try {
    parseRewriteManifest(JSON.parse(JSON.stringify(manifest)));
  } catch (error) {
    return {
      refused: true,
      reasons: [
        `derived manifest failed its own schema: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  return manifest;
};
