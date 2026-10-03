// @effect-diagnostics nodeBuiltinImport:off - Bot-owned refs are Git plumbing that runs before an Effect runtime exists.

// The bot-owned `refs/fork/*` family carries walk data that is not fork behaviour.
// Each ref is an orphan history the bot appends to and never rebases, so the fork
// series stays free of the rows and caches a rebase would otherwise have to carry.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runCommand, runCommandText } from "./fork-command.ts";

/** Ledger of every unblock walk, one JSON file, machine-readable (RSI-Software/t3code-hyprws#476). */
export const CHURN_REF = "refs/fork/churn";
export const CHURN_LEDGER_FILE = "fork-churn.json";
/** Shared rerere cache the walks accumulate (RSI-Software/t3code-hyprws#444). */
export const RERERE_REF = "refs/fork/rerere";

/** Bot ref APIs accept names only. Immutable commit reads use git show directly. */
export const requireBotRef = (ref: string): string => {
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
export const fetchBotRef = (root: string, ref: string): boolean => {
  requireBotRef(ref);
  return gitResult(root, ["fetch", "--quiet", "origin", `+${ref}:${ref}`]).status === 0;
};

/** Resolve a bot-owned ref, fetching once when the checkout has not seen it yet. */
export const resolveBotRef = (root: string, ref: string): string | null => {
  requireBotRef(ref);
  if (!refExists(root, ref)) fetchBotRef(root, ref);
  if (!refExists(root, ref)) return null;
  return gitText(root, ["rev-parse", `${ref}^{commit}`]).trim();
};

/** Read one file out of a bot-owned ref. `null` means the ref or the file is absent. */
export const readBotRefFile = (root: string, ref: string, file: string): string | null => {
  if (resolveBotRef(root, ref) === null) return null;
  const result = gitResult(root, ["show", `${ref}:${file}`]);
  return result.status === 0 && result.error === undefined ? result.stdout : null;
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

/** Replace a bot-owned ref's single-file tree. Returns the ref's new commit. */
export const writeBotRefFile = (
  root: string,
  ref: string,
  file: string,
  contents: string,
  message: string,
): string => {
  const blob = gitText(root, ["hash-object", "-w", "--stdin"], contents).trim();
  const tree = gitText(root, ["mktree"], `100644 blob ${blob}\t${file}\n`).trim();
  return commitBotRef(root, ref, tree, message);
};

/** Publish a bot-owned ref. Credentials come from the caller's Git environment. */
export const pushBotRef = (root: string, ref: string): void => {
  gitText(root, ["push", "--quiet", "origin", `${ref}:${ref}`]);
};

/** Publish a rewritten bot-owned ref only if origin still has the commit the caller read. */
export const pushBotRefWithLease = (root: string, ref: string, expectedOld: string): void => {
  gitText(root, [
    "push",
    "--quiet",
    `--force-with-lease=${ref}:${expectedOld}`,
    "origin",
    `${ref}:${ref}`,
  ]);
};

/** One publishing write's hold on a bot-owned ref (RSI-Software/t3code-hyprws#631). */
export interface BotRefLease {
  readonly ref: string;
  /** The published commit the write is leased against; the exact expected-old value. */
  readonly expectedOld: string;
  /** The local commit the write builds on, and the commit a refused publication restores. */
  readonly base: string;
}

/** Every fail-closed lease report names all three SHAs so the operator can compare them. */
const leaseFailure = (
  ref: string,
  reason: string,
  local: string | null,
  remote: string | null,
  expected: string | null,
): string =>
  `${ref} ${reason}; local=${local ?? "none"}, remote=${remote ?? "unknown"}, expected=${expected ?? "none"}; neither ref was overwritten`;

const localBotRef = (root: string, ref: string): string | null =>
  refExists(root, ref) ? gitText(root, ["rev-parse", `${ref}^{commit}`]).trim() : null;

type AdvertisedBotRef =
  | { readonly kind: "published"; readonly sha: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreachable"; readonly detail: string };

/** Ask origin what it publishes. An unchecked remote is never treated as an absent one. */
const advertisedBotRef = (root: string, ref: string): AdvertisedBotRef => {
  const result = runCommand("git", ["ls-remote", "--exit-code", "origin", ref], {
    cwd: root,
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error !== undefined) return { kind: "unreachable", detail: result.error.message };
  if (result.status === 2) return { kind: "absent" };
  if (result.status !== 0)
    return {
      kind: "unreachable",
      detail: result.stderr.trim() || `git ls-remote exit ${result.status}`,
    };
  const sha = result.stdout
    .trim()
    .split("\n")
    .find((line) => line.split("\t")[1] === ref)
    ?.split("\t")[0];
  if (sha === undefined || !/^[a-f0-9]{40,64}$/.test(sha))
    return { kind: "unreachable", detail: "origin advertised no usable commit for the ref" };
  return { kind: "published", sha };
};

const objectExists = (root: string, sha: string): boolean =>
  gitResult(root, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;

const isAncestor = (root: string, ancestor: string, descendant: string): boolean => {
  const result = gitResult(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1))
    throw new Error(`could not compare ${ancestor} with ${descendant}: ${result.stderr.trim()}`);
  return result.status === 0;
};

/**
 * Start a mutating write from the ref origin advertises rather than from whatever the
 * checkout last saw, so an existing checkout appends to an advanced ledger instead of
 * failing its lease forever (RSI-Software/t3code-hyprws#631). `publish` false keeps the
 * documented local-writer behaviour: no remote query, and the local ref is the base.
 * Returns null when the ref has never been seeded, which callers report themselves.
 */
export const acquireBotRefLease = (
  root: string,
  ref: string,
  publish: boolean,
): BotRefLease | null => {
  requireBotRef(ref);
  if (!publish) {
    const local = resolveBotRef(root, ref);
    return local === null ? null : { ref, expectedOld: local, base: local };
  }
  const local = localBotRef(root, ref);
  const advertised = advertisedBotRef(root, ref);
  if (advertised.kind === "absent") {
    if (local === null) return null;
    throw new Error(
      leaseFailure(
        ref,
        "is absent on origin; a published ledger cannot be leased",
        local,
        null,
        null,
      ),
    );
  }
  if (advertised.kind === "unreachable")
    throw new Error(
      leaseFailure(ref, `could not be read from origin (${advertised.detail})`, local, null, null),
    );
  const expectedOld = advertised.sha;
  if (!objectExists(root, expectedOld)) {
    // Fetch objects only. A pending local append must survive the refresh below.
    gitResult(root, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", ref]);
    if (!objectExists(root, expectedOld))
      throw new Error(
        leaseFailure(
          ref,
          "moved on origin while its published commit was fetched",
          local,
          expectedOld,
          expectedOld,
        ),
      );
  }
  if (local === null) {
    gitText(root, ["update-ref", ref, expectedOld, ""]);
    return { ref, expectedOld, base: expectedOld };
  }
  if (local === expectedOld) return { ref, expectedOld, base: local };
  if (isAncestor(root, local, expectedOld)) {
    // Stale checkout: fast-forward onto the published ledger so the write appends to it.
    gitText(root, ["update-ref", ref, expectedOld, local]);
    return { ref, expectedOld, base: expectedOld };
  }
  // Unpushed local evidence already descends from the published head; keep it and lease
  // against origin so the publication stays a fast-forward.
  if (isAncestor(root, expectedOld, local)) return { ref, expectedOld, base: local };
  throw new Error(
    leaseFailure(ref, "has diverged from the published ledger", local, expectedOld, expectedOld),
  );
};

/**
 * Publish a leased write. A remote that moved after the lease was taken fails closed with
 * all three SHAs and restores the local ref, so a normal rerun refreshes and succeeds.
 */
export const publishBotRefLease = (root: string, lease: BotRefLease, commit: string): void => {
  try {
    pushBotRefWithLease(root, lease.ref, lease.expectedOld);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (commit !== lease.base)
      try {
        gitText(root, ["update-ref", lease.ref, lease.base, commit]);
      } catch (restoreError) {
        throw new Error(
          `${message}\nfailed to restore ${lease.ref} to ${lease.base}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          { cause: restoreError },
        );
      }
    const observed = advertisedBotRef(root, lease.ref);
    throw new Error(
      `${message}\n${leaseFailure(
        lease.ref,
        "publication refused",
        commit,
        observed.kind === "published" ? observed.sha : null,
        lease.expectedOld,
      )}`,
      { cause: error },
    );
  }
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
 * Store `.git/rr-cache` on its bot-owned ref so the next blocked walk replays the
 * resolutions the previous walks recorded. A missing or empty cache stores nothing.
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
const rerereEntries = (root: string, commit: string | null): Map<string, string> => {
  const entries = new Map<string, string>();
  if (commit === null) return entries;
  for (const row of gitText(root, ["ls-tree", "-rz", commit]).split("\0")) {
    if (row === "") continue;
    const match = /^100644 blob ([a-f0-9]+)\t(.+)$/.exec(row);
    if (match === null) throw new Error(`unsupported rerere cache entry: ${row}`);
    const [, blob, path] = match;
    if (blob === undefined || path === undefined) throw new Error("invalid rerere entry");
    // Git rewrites thisimage while checking an unresolved conflict. It is not a
    // reusable resolution and must not contend with another walk's observation.
    if (/\/thisimage(?:\.\d+)?$/.test(path)) continue;
    entries.set(path, blob);
  }
  return entries;
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
  for (let attempt = 1; attempt <= 3; attempt++) {
    const expectedOld = remoteRerereHead(root);
    const merged = rerereEntries(root, expectedOld);
    for (const [path, blob] of pending) {
      const existing = merged.get(path);
      if (existing !== undefined && existing !== blob)
        throw new Error(
          `rerere resolution disagreement at ${path}; neither resolution was overwritten`,
        );
      merged.set(path, blob);
    }
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
    return true;
  });
};
