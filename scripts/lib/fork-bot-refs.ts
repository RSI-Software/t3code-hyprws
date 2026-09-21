// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Bot-owned refs are Git plumbing that runs before an Effect runtime exists.

// The bot-owned `refs/fork/rerere` ref carries the shared rerere cache the sync
// driver accumulates (RSI-Software/t3code-hyprws#444). The ref is an orphan
// history the bot appends to and never rebases, so the fork series stays free of
// the caches a rebase would otherwise have to carry.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runCommand, runCommandText } from "./fork-command.ts";

/** Shared rerere cache the sync runs accumulate (RSI-Software/t3code-hyprws#444). */
export const RERERE_REF = "refs/fork/rerere";

/** Bot ref APIs accept names only. Immutable commit reads use git show directly. */
const requireBotRef = (ref: string): string => {
  if (!/^refs\/fork\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/.test(ref))
    throw new Error("expected a named refs/fork/... ref, not a SHA or branch name");
  return ref;
};

const gitResult = (root: string, args: ReadonlyArray<string>) =>
  runCommand("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });

const gitText = (root: string, args: ReadonlyArray<string>, input?: string): string =>
  runCommandText("git", args, { cwd: root, ...(input === undefined ? {} : { input }) });

const refExists = (root: string, ref: string): boolean =>
  gitResult(root, ["show-ref", "--verify", "--quiet", ref]).status === 0;

/**
 * Bring a bot-owned ref down from origin. It is never rebased, so a forced local
 * update only ever fast-forwards onto the bot's own append.
 */
const fetchBotRef = (root: string, ref: string): boolean =>
  gitResult(root, ["fetch", "--quiet", "origin", `+${ref}:${ref}`]).status === 0;

/** Resolve a bot-owned ref, fetching once when the checkout has not seen it yet. */
export const resolveBotRef = (root: string, ref: string): string | null => {
  requireBotRef(ref);
  if (!refExists(root, ref)) fetchBotRef(root, ref);
  if (!refExists(root, ref)) return null;
  return gitText(root, ["rev-parse", `${ref}^{commit}`]).trim();
};

const commitBotRef = (root: string, ref: string, tree: string, message: string): string => {
  const parent = resolveBotRef(root, ref);
  if (parent !== null && gitText(root, ["rev-parse", `${ref}^{tree}`]).trim() === tree)
    return parent;
  const commit = gitText(root, [
    "commit-tree",
    tree,
    ...(parent === null ? [] : ["-p", parent]),
    "-m",
    message,
  ]).trim();
  gitText(root, ["update-ref", ref, commit, ...(parent === null ? [] : [parent])]);
  return commit;
};

const temporaryIndex = <T>(effect: (indexFile: string) => T): T => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-bot-ref-"));
  try {
    return effect(NodePath.join(directory, "index"));
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

const rerereCachePath = (root: string): string =>
  NodePath.resolve(root, gitText(root, ["rev-parse", "--git-common-dir"]).trim(), "rr-cache");

/**
 * Store `.git/rr-cache` on its bot-owned ref so the next blocked run replays the
 * resolutions the previous runs recorded. A missing or empty cache stores nothing.
 */
export const saveRerereCache = (root: string, message: string, ref = RERERE_REF): string | null => {
  const cache = rerereCachePath(root);
  if (!NodeFS.existsSync(cache) || NodeFS.readdirSync(cache).length === 0) return null;
  return temporaryIndex((indexFile) => {
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    const add = runCommand("git", ["--work-tree", cache, "add", "--all", "--force", "."], {
      cwd: cache,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (add.status !== 0) throw new Error(`git add of ${cache} failed: ${add.stderr.trim()}`);
    const write = runCommand("git", ["write-tree"], { cwd: root, env });
    if (write.status !== 0) throw new Error(`git write-tree failed: ${write.stderr.trim()}`);
    return commitBotRef(root, ref, write.stdout.trim(), message);
  });
};

/** Merge immutable cache snapshots, refusing a different resolution for the same key. */
const rerereEntries = (
  root: string,
  commit: string | null,
): { entries: Map<string, string>; regenerated: Set<string> } => {
  const entries = new Map<string, string>();
  // A regenerated file — `pnpm-lock.yaml` is rebuilt on every run — is never a human
  // resolution, and its postimage can never agree across two runs. Git's rr-cache key
  // carries no path, so identify such entries by the preimage's first line and skip them
  // in both publication directions instead of failing or publishing a stale lockfile.
  const regenerated = new Set<string>();
  if (commit === null) return { entries, regenerated };
  const rows: Array<{ blob: string; path: string }> = [];
  for (const row of gitText(root, ["ls-tree", "-rz", commit]).split("\0")) {
    if (row === "") continue;
    const match = /^100644 blob ([a-f0-9]+)\t(.+)$/.exec(row);
    if (match === null) throw new Error(`unsupported rerere cache entry: ${row}`);
    const [, blob, path] = match;
    if (blob === undefined || path === undefined) throw new Error("invalid rerere entry");
    rows.push({ blob, path });
  }
  for (const { blob, path } of rows) {
    // Git rewrites thisimage while checking an unresolved conflict. It is not a
    // reusable resolution and must not contend with another run's observation.
    if (/\/thisimage(?:\.\d+)?$/.test(path)) continue;
    if (/^[0-9a-f]{40,64}\/preimage(?:\.\d+)?$/.test(path)) {
      const id = path.split("/")[0]!;
      if (gitText(root, ["cat-file", "blob", blob]).startsWith("lockfileVersion:")) {
        regenerated.add(id);
        continue;
      }
    }
    entries.set(path, blob);
  }
  for (const id of regenerated) {
    for (const path of [...entries.keys()]) if (path.startsWith(`${id}/`)) entries.delete(path);
  }
  return { entries, regenerated };
};

const variantPath = /^([^/]+)\/(preimage|postimage)(?:\.(\d+))?$/;

const slot = (index: string | undefined): number => (index === undefined ? 0 : Number(index));

type RerereVariant = { preimage?: string; postimage?: string };

/** Group `<id>/{pre,post}image[.N]` rows into git's per-id variant slots. */
const rerereVariants = (
  entries: Map<string, string>,
): { variants: Map<string, Map<number, RerereVariant>>; plain: Map<string, string> } => {
  const variants = new Map<string, Map<number, RerereVariant>>();
  const plain = new Map<string, string>();
  for (const [path, blob] of entries) {
    const match = variantPath.exec(path);
    if (match === null) {
      plain.set(path, blob);
      continue;
    }
    const [, id, kind, index] = match;
    const slots = variants.get(id!) ?? new Map<number, RerereVariant>();
    slots.set(slot(index), { ...slots.get(slot(index)), [kind!]: blob });
    variants.set(id!, slots);
  }
  return { variants, plain };
};

/**
 * Add `pending` to `merged` by git's rerere identity, not by path. An rr-cache id
 * hashes only the conflict hunks, so the same seam under a different context is the
 * same id with a different preimage, and git numbers such variants per clone
 * (`preimage.N`/`postimage.N`). A pending variant therefore joins the shared slot
 * whose preimage it equals, or opens a new slot after the highest one. Only a
 * different postimage for the same preimage is a disagreement.
 */
const mergeRerereEntries = (
  merged: Map<string, string>,
  pending: Map<string, string>,
): Map<string, string> => {
  const target = rerereVariants(merged);
  const source = rerereVariants(pending);
  for (const [path, blob] of source.plain) {
    const existing = target.plain.get(path);
    if (existing !== undefined && existing !== blob)
      throw new Error(
        `rerere resolution disagreement at ${path}; neither resolution was overwritten`,
      );
    target.plain.set(path, blob);
  }
  for (const [id, slots] of source.variants) {
    const shared = target.variants.get(id) ?? new Map<number, RerereVariant>();
    target.variants.set(id, shared);
    for (const variant of slots.values()) {
      const match = [...shared].find(
        ([, candidate]) =>
          variant.preimage !== undefined && candidate.preimage === variant.preimage,
      );
      if (match === undefined) {
        shared.set(shared.size === 0 ? 0 : Math.max(...shared.keys()) + 1, { ...variant });
        continue;
      }
      const [slot, candidate] = match;
      if (variant.postimage === undefined) continue;
      if (candidate.postimage !== undefined && candidate.postimage !== variant.postimage)
        throw new Error(
          `rerere resolution disagreement at ${id}/postimage${slot === 0 ? "" : `.${slot}`}; neither resolution was overwritten`,
        );
      candidate.postimage = variant.postimage;
    }
  }
  const result = new Map(target.plain);
  for (const [id, slots] of target.variants)
    for (const [slot, variant] of slots)
      for (const kind of ["preimage", "postimage"] as const) {
        const blob = variant[kind];
        if (blob !== undefined) result.set(`${id}/${kind}${slot === 0 ? "" : `.${slot}`}`, blob);
      }
  return result;
};

const remoteRerereHead = (root: string): string | null => {
  const remote = gitText(root, ["ls-remote", "origin", RERERE_REF]).trim();
  if (remote === "") return null;
  // Fetch the advertised object, not into the local ref holding our pending
  // snapshot. A concurrent publisher must never erase our unpushed additions.
  const sha = remote.split(/\s+/)[0];
  if (sha === undefined || !/^[a-f0-9]{40,64}$/.test(sha))
    throw new Error("invalid remote rerere head");
  gitText(root, ["fetch", "--quiet", "--no-write-fetch-head", "origin", sha]);
  return sha;
};

const pushRerereSnapshot = (root: string, commit: string, expectedOld: string): void => {
  gitText(root, [
    "push",
    "--quiet",
    `--force-with-lease=${RERERE_REF}:${expectedOld}`,
    "origin",
    `${commit}:${RERERE_REF}`,
  ]);
};

/** Publish an immutable snapshot with an additive merge and at most three leased pushes. */
export const publishRerereSnapshot = (
  root: string,
  snapshot: string,
  push: typeof pushRerereSnapshot = pushRerereSnapshot,
): string => {
  const pending = rerereEntries(root, snapshot);
  // One note per skipped id, not one per leased attempt.
  const noted = new Set<string>();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const expectedOld = remoteRerereHead(root);
    for (const id of pending.regenerated)
      if (!noted.has(id)) {
        noted.add(id);
        console.log(`note: skipping regenerated lockfile rerere entry ${id}/postimage`);
      }
    const merged = mergeRerereEntries(rerereEntries(root, expectedOld).entries, pending.entries);
    const tree = temporaryIndex((indexFile) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      const input = [...merged].map(([path, blob]) => `100644 ${blob}\t${path}\0`).join("");
      const update = runCommand("git", ["update-index", "-z", "--index-info"], {
        cwd: root,
        env,
        input,
      });
      if (update.status !== 0) throw new Error(`rerere index failed: ${update.stderr.trim()}`);
      return runCommandText("git", ["write-tree"], { cwd: root, env }).trim();
    });
    if (
      expectedOld !== null &&
      gitText(root, ["rev-parse", `${expectedOld}^{tree}`]).trim() === tree
    )
      return expectedOld;
    const commit = gitText(root, [
      "commit-tree",
      tree,
      ...(expectedOld === null ? [] : ["-p", expectedOld]),
      "-m",
      "rerere: retain concurrent cache additions",
    ]).trim();
    try {
      push(root, commit, expectedOld ?? "");
      return commit;
    } catch (error) {
      // An auth/network failure is not a lease race. Never retry it blindly.
      const observed = remoteRerereHead(root);
      if (observed === commit) return commit;
      if (observed === expectedOld) throw error;
      if (attempt === 3)
        throw new Error(
          "rerere publication exhausted 3 leased attempts; snapshot retained for resume",
          { cause: error },
        );
    }
  }
  throw new Error("unreachable rerere publication state");
};

/**
 * Restore the shared rerere cache into `.git/rr-cache`. Returns false when the ref
 * does not exist yet, which is the first-run state rather than a failure.
 * Regenerated-lockfile entries are never restored: an older run's published lockfile
 * resolution would replay a stale lockfile over this run's regenerated one.
 */
export const restoreRerereCache = (root: string, ref = RERERE_REF): boolean => {
  if (resolveBotRef(root, ref) === null) return false;
  const cache = rerereCachePath(root);
  NodeFS.mkdirSync(cache, { recursive: true });
  return temporaryIndex((indexFile) => {
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    const read = runCommand("git", ["read-tree", `${ref}^{tree}`], { cwd: root, env });
    if (read.status !== 0) throw new Error(`git read-tree ${ref} failed: ${read.stderr.trim()}`);
    const checkout = runCommand("git", ["--work-tree", cache, "checkout-index", "-a", "-f"], {
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (checkout.status !== 0)
      throw new Error(`git checkout-index into ${cache} failed: ${checkout.stderr.trim()}`);
    for (const id of NodeFS.readdirSync(cache)) {
      const preimage = NodePath.join(cache, id, "preimage");
      if (!NodeFS.existsSync(preimage)) continue;
      if (NodeFS.readFileSync(preimage, "utf8").startsWith("lockfileVersion:")) {
        NodeFS.rmSync(NodePath.join(cache, id), { recursive: true, force: true });
        console.log(`note: skipping regenerated lockfile rerere entry ${id}/postimage`);
      }
    }
    return true;
  });
};
