// @effect-diagnostics nodeBuiltinImport:off - Binary Git plumbing for an offline, object-only constructor.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { UsageError } from "./fork-cli.ts";
import { externalPath } from "./fork-external-path.ts";
import { makeProgressReporter } from "./fork-progress.ts";

export const REWRITE_MANIFEST_SCHEMA = "fork.rewrite-manifest.v1";
export const REWRITE_RECEIPT_SCHEMA = "fork.rewrite-build.v1";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export interface RewriteEntry {
  readonly mode: "100644" | "100755" | "120000" | "160000";
  readonly type: "blob" | "commit";
  readonly oid: string;
}
interface ReadEntry {
  readonly path: string;
  readonly entry: RewriteEntry | null;
}
/** Where a folded change's attribution came from; absent on a manifest frozen before the record. */
export type RewriteOrigin =
  | { readonly kind: "blame" }
  | { readonly kind: "operator"; readonly commit: string };
interface RewriteChange {
  readonly path: string;
  readonly before: RewriteEntry | null;
  readonly after: RewriteEntry | null;
  readonly reason: string;
  readonly origin?: RewriteOrigin;
}
export interface RewriteAttribution {
  readonly path: string;
  readonly commit: string;
}
/**
 * The operator decisions a fold was given. `--attribute` and `--leave` are the only parts of a
 * fold nothing derives, so a reviewer holding the manifest alone must be able to read them back.
 */
export interface RewriteOverrides {
  /** Attributions that placed changes, each naming the commit the operator chose. */
  readonly attributed: ReadonlyArray<RewriteAttribution>;
  /** Paths the operator excluded that a reshape diff carried, so the fold skipped them. */
  readonly left: ReadonlyArray<string>;
  /** Flag text for overrides that bound to nothing, as `attribute <path>=<value>` or `leave <path>`. */
  readonly unused: ReadonlyArray<string>;
}
interface RewriteSlot {
  readonly commit: string;
  readonly tree: string;
  readonly resultTree: string;
  readonly readSet: ReadonlyArray<ReadEntry>;
  readonly changes: ReadonlyArray<RewriteChange>;
}
const sameEntry = (left: RewriteEntry | null, right: RewriteEntry | null): boolean =>
  left === null || right === null
    ? left === right
    : left.mode === right.mode && left.type === right.type && left.oid === right.oid;
export interface RewriteManifest {
  readonly schema: typeof REWRITE_MANIFEST_SCHEMA;
  readonly source: string;
  readonly sourceTree: string;
  readonly base: string;
  readonly baseTag: string;
  /** Reviewed proof artifacts, not checks executed by this constructor. */
  readonly proofs: ReadonlyArray<{
    readonly name: string;
    readonly artifact: string;
    readonly sha256: string;
  }>;
  readonly expected: {
    readonly changedSlots: number;
    readonly unchangedSlots: number;
    readonly removedSignatures: number;
  };
  readonly unresolved: ReadonlyArray<string>;
  /** Absent on a manifest frozen before operator decisions were recorded. */
  readonly overrides?: RewriteOverrides;
  readonly slots: ReadonlyArray<RewriteSlot>;
}
export interface RewriteBuildReceipt {
  readonly schema: typeof REWRITE_RECEIPT_SCHEMA;
  readonly manifestSha256: string;
  readonly source: string;
  readonly base: string;
  readonly baseTag: string;
  readonly result: string;
  readonly finalTree: string;
  readonly slots: ReadonlyArray<{
    readonly original: string;
    readonly rebuilt: string;
    readonly tree: string;
    readonly treeChanged: boolean;
    readonly changedPaths: ReadonlyArray<string>;
    readonly removedSignatureSha256: string | null;
  }>;
}
export class RewritePreconditionError extends Error {
  readonly isPrecondition = true;
}
const fail = (message: string): never => {
  throw new RewritePreconditionError(message);
};
const requireConsistentGitConfig = (): void => {
  // GIT_CONFIG redirects only `git config`, hiding settings consumed by object commands.
  if ((process.env.GIT_CONFIG ?? "").length > 0)
    fail("GIT_CONFIG must be unset for consistent offline reconstruction configuration");
};
const object = (input: unknown, keys: ReadonlyArray<string>): Record<string, unknown> => {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new UsageError("expected rewrite manifest object");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new UsageError("unknown rewrite manifest field");
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new UsageError("expected nonempty rewrite manifest string");
  return value;
};
const sha = (value: unknown): string => {
  const result = text(value);
  if (!SHA.test(result)) throw new UsageError("rewrite requires exact SHA-1 object IDs");
  return result;
};
const array = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new UsageError("expected rewrite manifest array");
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new UsageError("rewrite expectation requires a nonnegative integer");
  return value;
};
const path = (value: unknown): string => {
  const result = text(value);
  if (
    result.startsWith("/") ||
    result.includes("\\") ||
    [...result].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    result.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
  )
    throw new UsageError(`invalid repository path: ${result}`);
  return result;
};
const entry = (value: unknown): RewriteEntry | null => {
  if (value === null) return null;
  const row = object(value, ["mode", "type", "oid"]);
  if (!["100644", "100755", "120000", "160000"].includes(String(row.mode)))
    throw new UsageError("unsupported rewrite entry mode");
  if (row.type !== (row.mode === "160000" ? "commit" : "blob"))
    throw new UsageError("rewrite entry mode/type disagree");
  return {
    mode: row.mode as RewriteEntry["mode"],
    type: row.type as RewriteEntry["type"],
    oid: sha(row.oid),
  };
};
const provenance = (value: unknown): RewriteOrigin | undefined => {
  if (value === undefined) return undefined;
  const row = object(value, ["kind", "commit"]);
  if (row.kind === "operator") return { kind: "operator", commit: sha(row.commit) };
  if (row.kind !== "blame") throw new UsageError("unknown change provenance kind");
  if ("commit" in row) throw new UsageError("blame provenance cannot name an operator commit");
  return { kind: "blame" };
};
/** An ineffective override is kept as the operator's own flag text; it binds to no slot. */
const unusedOverride = (value: unknown): { readonly record: string; readonly path: string } => {
  const record = text(value);
  const space = record.indexOf(" ");
  if (space <= 0) throw new UsageError(`unused override must name a flag and a path: ${record}`);
  const rest = record.slice(space + 1);
  if (record.slice(0, space) === "leave") return { record, path: path(rest) };
  if (record.slice(0, space) !== "attribute")
    throw new UsageError(`unused override must name an attribute or leave flag: ${record}`);
  const equals = rest.indexOf("=");
  if (equals <= 0 || equals === rest.length - 1)
    throw new UsageError(`unused attribute override must read <path>=<commit>: ${record}`);
  return { record, path: path(rest.slice(0, equals)) };
};
/**
 * Bind the recorded operator decisions to the slots they claim, so neither half of the record can
 * be edited alone: an attribution must own every change at its path and start no later than the
 * first slot folding it, and an excluded path must own none. Tree-neutrality holds whichever slot
 * absorbs a change, so this cross-check is the only thing standing between a mistyped
 * `--attribute` and a rewrite that passes every other proof.
 */
const overrideRecord = (input: unknown, slots: ReadonlyArray<RewriteSlot>): RewriteOverrides => {
  const row = object(input, ["attributed", "left", "unused"]);
  const attributed = array(row.attributed).map((input): RewriteAttribution => {
    const record = object(input, ["path", "commit"]);
    return { path: path(record.path), commit: sha(record.commit) };
  });
  const left = array(row.left).map(path);
  const unused = array(row.unused).map(unusedOverride);
  const claimed = [...attributed.map((row) => row.path), ...left, ...unused.map((row) => row.path)];
  if (new Set(claimed).size !== claimed.length)
    throw new UsageError("duplicate override path; one path carries one operator decision");
  const position = new Map(slots.map((slot, index) => [slot.commit, index]));
  const folded = new Map<
    string,
    Array<{ readonly slot: number; readonly origin: RewriteOrigin }>
  >();
  slots.forEach((slot, index) => {
    for (const change of slot.changes)
      folded.set(change.path, [
        ...(folded.get(change.path) ?? []),
        { slot: index, origin: change.origin ?? { kind: "blame" } },
      ]);
  });
  for (const entry of attributed) {
    const start =
      position.get(entry.commit) ??
      fail(`operator attribution names a commit outside the stack: ${entry.path}`);
    const changes = folded.get(entry.path) ?? [];
    if (changes.length === 0) fail(`operator attribution folds nothing: ${entry.path}`);
    for (const change of changes) {
      if (change.origin.kind !== "operator" || change.origin.commit !== entry.commit)
        fail(`operator attribution disagrees with its folded change: ${entry.path}`);
      if (change.slot < start)
        fail(`operator attribution is later than the first slot it folds: ${entry.path}`);
    }
  }
  for (const excluded of [...left, ...unused.map((row) => row.path)])
    if (folded.has(excluded))
      fail(`override excluded a path the manifest folds anyway: ${excluded}`);
  for (const [name, changes] of folded)
    for (const { origin } of changes) {
      if (origin.kind !== "operator") continue;
      if (!attributed.some((entry) => entry.path === name && entry.commit === origin.commit))
        fail(`operator-attributed change is absent from the override record: ${name}`);
    }
  return { attributed, left, unused: unused.map((row) => row.record) };
};
export const parseRewriteManifest = (input: unknown): RewriteManifest => {
  const value = object(input, [
    "schema",
    "source",
    "sourceTree",
    "base",
    "baseTag",
    "proofs",
    "expected",
    "unresolved",
    "overrides",
    "slots",
  ]);
  if (value.schema !== REWRITE_MANIFEST_SCHEMA)
    throw new UsageError(
      "expected executable fork.rewrite-manifest.v1; design inputs cannot execute",
    );
  const unresolved = array(value.unresolved).map(text);
  if (unresolved.length > 0) fail(`unresolved rewrite proof gates: ${unresolved.join(", ")}`);
  const proofs = array(value.proofs).map((input) => {
    const proof = object(input, ["name", "artifact", "sha256"]);
    const digest = text(proof.sha256);
    if (!DIGEST.test(digest)) throw new UsageError("proof requires SHA-256 artifact digest");
    return { name: text(proof.name), artifact: path(proof.artifact), sha256: digest };
  });
  for (const name of ["snapshot-tests", "composition", "test-ownership", "compatibility"])
    if (proofs.filter((proof) => proof.name === name).length !== 1)
      fail(`exactly one reviewed ${name} proof is required`);
  if (new Set(proofs.map((proof) => proof.name)).size !== proofs.length)
    throw new UsageError("duplicate rewrite proof name");
  if (new Set(proofs.map((proof) => proof.artifact)).size !== proofs.length)
    throw new UsageError("duplicate rewrite proof artifact");
  const slots = array(value.slots).map((input): RewriteSlot => {
    const slot = object(input, ["commit", "tree", "resultTree", "readSet", "changes"]);
    const readSet = array(slot.readSet).map((input) => {
      const read = object(input, ["path", "entry"]);
      return { path: path(read.path), entry: entry(read.entry) };
    });
    const changes = array(slot.changes).map((input) => {
      const change = object(input, ["path", "before", "after", "reason", "origin"]);
      const origin = provenance(change.origin);
      const parsed = {
        path: path(change.path),
        before: entry(change.before),
        after: entry(change.after),
        reason: text(change.reason),
        ...(origin === undefined ? {} : { origin }),
      };
      if (sameEntry(parsed.before, parsed.after))
        throw new UsageError(`rewrite change must alter its entry: ${parsed.path}`);
      return parsed;
    });
    for (const rows of [readSet, changes])
      if (new Set(rows.map((row) => row.path)).size !== rows.length)
        throw new UsageError("duplicate snapshot path; compose overlapping transforms explicitly");
    return {
      commit: sha(slot.commit),
      tree: sha(slot.tree),
      resultTree: sha(slot.resultTree),
      readSet,
      changes,
    };
  });
  if (slots.length === 0) throw new UsageError("rewrite manifest has no commit slots");
  // All or nothing: a manifest either predates the override record or states every change's
  // provenance, so a recorded attribution cannot be hidden by dropping one change's origin.
  const changed = slots.flatMap((slot) => slot.changes);
  if (value.overrides === undefined) {
    if (changed.some((change) => change.origin !== undefined))
      throw new UsageError("change provenance requires the manifest override record");
  } else if (changed.some((change) => change.origin === undefined))
    throw new UsageError("a recorded override set requires provenance on every change");
  const overrides =
    value.overrides === undefined ? undefined : overrideRecord(value.overrides, slots);
  const expectedValue = object(value.expected, [
    "changedSlots",
    "unchangedSlots",
    "removedSignatures",
  ]);
  const expected = {
    changedSlots: count(expectedValue.changedSlots),
    unchangedSlots: count(expectedValue.unchangedSlots),
    removedSignatures: count(expectedValue.removedSignatures),
  };
  if (expected.changedSlots + expected.unchangedSlots !== slots.length)
    fail("rewrite slot expectations must account for every manifest slot");
  const baseTag = text(value.baseTag);
  if (!/^v\d+\.\d+\.\d+(?:-nightly\.[A-Za-z0-9.]+)?$/.test(baseTag))
    throw new UsageError("rewrite base must name an upstream release tag");
  return {
    schema: REWRITE_MANIFEST_SCHEMA,
    source: sha(value.source),
    sourceTree: sha(value.sourceTree),
    base: sha(value.base),
    baseTag,
    proofs,
    expected,
    unresolved,
    ...(overrides === undefined ? {} : { overrides }),
    slots,
  };
};

/** No shell, index, replacement refs, network, or ref-update commands. */
export class RewriteObjects {
  private readonly known = new Set<string>();
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    requireConsistentGitConfig();
    // Git 2.43 can fetch from an object read; metadata checks must precede traversal.
    const keys = this.text(["config", "--includes", "--name-only", "--null", "--list"])
      .split("\0")
      .map((key) => key.toLowerCase());
    if (
      keys.some(
        (key) =>
          key === "extensions.partialclone" ||
          /^remote\.[\s\S]*\.(?:promisor|partialclonefilter)$/.test(key),
      )
    )
      fail("partial/promisor repository configuration cannot be used for offline reconstruction");
    const objectDirectory = NodePath.resolve(
      root,
      this.text(["rev-parse", "--git-path", "objects"]),
    );
    if (
      (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "").length > 0 ||
      ["alternates", "http-alternates"].some((name) => {
        const file = NodePath.join(objectDirectory, "info", name);
        return NodeFS.existsSync(file) && NodeFS.readFileSync(file).length > 0;
      })
    )
      fail("alternate object stores cannot establish an offline reconstruction boundary");
    const packDirectory = NodePath.join(objectDirectory, "pack");
    if (
      NodeFS.existsSync(packDirectory) &&
      NodeFS.readdirSync(packDirectory).some((name) => name.endsWith(".promisor"))
    )
      fail("promisor object-store markers cannot be used for offline reconstruction");
  }
  git(args: ReadonlyArray<string>, input?: Buffer): Buffer {
    const result = NodeChildProcess.spawnSync("git", ["--no-replace-objects", ...args], {
      cwd: this.root,
      input,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error)
      throw new Error(
        `rewrite git ${args[0]} failed: ${result.stderr?.toString() ?? result.error?.message}`,
      );
    return result.stdout;
  }
  text(args: ReadonlyArray<string>): string {
    return this.git(args).toString("utf8").trim();
  }
  hash(type: "tree" | "commit", bytes: Buffer, write: boolean): string {
    const oid = NodeCrypto.createHash("sha1")
      .update(`${type} ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (write && !this.known.has(oid)) {
      const actual = this.git(["hash-object", "-t", type, "-w", "--stdin"], bytes)
        .toString("ascii")
        .trim();
      if (actual !== oid) fail("Git object hash differs from constructed bytes");
      this.known.add(oid);
    }
    return oid;
  }
  entries(tree: string): Map<string, RewriteEntry> {
    const bytes = this.git(["ls-tree", "-rzt", "--full-tree", tree]);
    this.known.add(tree);
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded).equals(bytes))
      fail("non-UTF8 tree paths require an explicit supported manifest");
    return new Map(
      decoded
        .split("\0")
        .filter(Boolean)
        .flatMap((line): Array<[string, RewriteEntry]> => {
          const tab = line.indexOf("\t"),
            [mode, type, oid] = line.slice(0, tab).split(" ");
          this.known.add(sha(oid));
          if (type === "tree" && oid === "4b825dc642cb6eb9a060e54bf8d69288fbee4904")
            fail(
              "explicit empty subtrees are unsupported; flattening would erase an undeclared entry",
            );
          let name: string;
          try {
            name = path(line.slice(tab + 1));
          } catch (error) {
            if (error instanceof UsageError) fail("unsupported tree path in frozen snapshot");
            throw error;
          }
          return type === "tree" ? [] : [[name, entry({ mode, type, oid })!]];
        }),
    );
  }
}
/** A grouped directory level: each name is either a blob entry or a nested directory. */
type TreeChild =
  | { readonly directory: false; readonly entry: RewriteEntry }
  | { readonly directory: true; readonly node: TreeNode };
interface TreeNode {
  readonly children: Map<string, TreeChild>;
}
/**
 * Groups the flat `path -> entry` map into a directory tree in one pass over `entries`
 * (each entry costs O(path segments), not O(entries) again), for `buildTree` to fold
 * bottom-up. Replaces an O(entries x directories) full-map rescan per directory with this
 * single grouping pass plus one hash per directory.
 */
const groupTree = (entries: ReadonlyMap<string, RewriteEntry>): TreeNode => {
  const root: TreeNode = { children: new Map() };
  for (const [name, item] of entries) {
    const segments = name.split("/");
    let node = root;
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const segment = segments[depth]!;
      const existing = node.children.get(segment);
      if (existing === undefined) {
        const child: TreeNode = { children: new Map() };
        node.children.set(segment, { directory: true, node: child });
        node = child;
      } else if (existing.directory) node = existing.node;
      else fail(`file/directory collision at ${segments.slice(0, depth + 1).join("/")}`);
    }
    const leaf = segments[segments.length - 1]!;
    if (node.children.has(leaf)) fail(`file/directory collision at ${name}`);
    node.children.set(leaf, { directory: false, entry: item });
  }
  return root;
};
/** Tree ordering compares directories with their trailing slash, as Git does. */
const buildTree = (
  objects: RewriteObjects,
  entries: ReadonlyMap<string, RewriteEntry>,
  write: boolean,
): string => {
  const build = (node: TreeNode): string => {
    const chunks = [...node.children]
      .map(([name, child]) => ({
        name,
        directory: child.directory,
        mode: child.directory ? "40000" : child.entry.mode,
        oid: child.directory ? build(child.node) : child.entry.oid,
      }))
      .sort((a, b) =>
        Buffer.compare(
          Buffer.from(`${a.name}${a.directory ? "/" : ""}`),
          Buffer.from(`${b.name}${b.directory ? "/" : ""}`),
        ),
      )
      .map((row) =>
        Buffer.concat([Buffer.from(`${row.mode} ${row.name}\0`), Buffer.from(row.oid, "hex")]),
      );
    return objects.hash("tree", Buffer.concat(chunks), write);
  };
  return build(groupTree(entries));
};

export const rebuildCommit = (raw: Buffer, tree: string, parent: string) => {
  const split = raw.indexOf(Buffer.from("\n\n"));
  if (split < 0) return fail("commit has no header/message separator");
  // Latin-1 is a reversible byte mapping, including non-UTF8 messages/identities.
  const headers = raw
    .subarray(0, split)
    .toString("latin1")
    .split(/\n(?! )/);
  const names = headers.map((header) => header.slice(0, header.indexOf(" ")));
  if (
    names.some(
      (name) => !["tree", "parent", "author", "committer", "encoding", "gpgsig"].includes(name),
    )
  )
    fail("unsupported commit metadata (including mergetag or alternate signatures)");
  for (const name of ["tree", "parent", "author", "committer"])
    if (names.filter((value) => value === name).length !== 1)
      fail(`commit requires exactly one ${name}`);
  if (new Set(names).size !== names.length) fail("duplicate commit metadata");
  const signature = headers.find((header) => header.startsWith("gpgsig "));
  const next = headers
    .filter((header) => !header.startsWith("gpgsig "))
    .map((header) =>
      header.startsWith("tree ")
        ? `tree ${tree}`
        : header.startsWith("parent ")
          ? `parent ${parent}`
          : header,
    );
  const unchanged =
    headers.find((header) => header.startsWith("tree ")) === `tree ${tree}` &&
    headers.find((header) => header.startsWith("parent ")) === `parent ${parent}`;
  return {
    bytes: unchanged
      ? raw
      : Buffer.concat([Buffer.from(next.join("\n") + "\n\n", "latin1"), raw.subarray(split + 2)]),
    removedSignatureSha256:
      unchanged || signature === undefined
        ? null
        : NodeCrypto.createHash("sha256").update(Buffer.from(signature, "latin1")).digest("hex"),
  };
};

export const buildRewrite = (
  root: string,
  rawManifest: Buffer,
  writeObjects = true,
): RewriteBuildReceipt => {
  const manifest = parseRewriteManifest(JSON.parse(rawManifest.toString("utf8")));
  const objects = new RewriteObjects(root);
  if (objects.text(["rev-parse", "--show-object-format"]) !== "sha1")
    fail("only SHA-1 repositories are supported");
  if (objects.text(["rev-parse", "--is-shallow-repository"]) !== "false")
    fail("shallow history cannot be reconstructed");
  const grafts = objects.text(["rev-parse", "--git-path", "info/grafts"]);
  if (
    NodeFS.existsSync(NodePath.resolve(root, grafts)) &&
    NodeFS.readFileSync(NodePath.resolve(root, grafts)).length > 0
  )
    fail("legacy grafts cannot be used for reconstruction");
  const checkSource = () => {
    if (objects.text(["rev-parse", "refs/remotes/origin/hyprws^{commit}"]) !== manifest.source)
      fail("stale rewrite source; freeze a new manifest");
    if (objects.text(["rev-parse", `refs/tags/${manifest.baseTag}^{commit}`]) !== manifest.base)
      fail("rewrite base tag moved");
  };
  checkSource();
  if (objects.text(["rev-parse", `${manifest.source}^{tree}`]) !== manifest.sourceTree)
    fail("frozen source tree does not match source commit");
  if (objects.text(["merge-base", manifest.base, manifest.source]) !== manifest.base)
    fail("rewrite base is not an ancestor of source");
  const commits = objects
    .text(["rev-list", "--reverse", "--topo-order", `${manifest.base}..${manifest.source}`])
    .split("\n");
  if (JSON.stringify(commits) !== JSON.stringify(manifest.slots.map((slot) => slot.commit)))
    fail("manifest must enumerate every original commit once, in order");
  const reportProgress = makeProgressReporter("rewrite-build");
  const slotCount = manifest.slots.length;
  let originalParent = manifest.base;
  const prepared = manifest.slots.map((slot, index) => {
    const raw = objects.git(["cat-file", "commit", slot.commit]);
    const header = raw.subarray(0, raw.indexOf(Buffer.from("\n\n"))).toString("latin1");
    if (
      !header.startsWith(`tree ${slot.tree}\n`) ||
      !header.includes(`\nparent ${originalParent}\n`)
    )
      fail(`original tree/parent mismatch at ${slot.commit}`);
    rebuildCommit(raw, slot.tree, originalParent);
    originalParent = slot.commit;
    const entries = objects.entries(slot.tree);
    for (const read of slot.readSet)
      if (!sameEntry(entries.get(read.path) ?? null, read.entry))
        fail(`read-set mismatch: ${read.path}`);
    for (const change of slot.changes) {
      if (!sameEntry(entries.get(change.path) ?? null, change.before))
        fail(`input mismatch: ${change.path}`);
      if (
        !slot.readSet.some(
          (read) => read.path === change.path && sameEntry(read.entry, change.before),
        )
      )
        fail(`changed path missing from read set: ${change.path}`);
      if (change.after === null) entries.delete(change.path);
      else {
        if (objects.text(["cat-file", "-t", change.after.oid]) !== change.after.type)
          fail(`replacement object type mismatch: ${change.path}`);
        entries.set(change.path, change.after);
      }
    }
    const tree = buildTree(objects, entries, false);
    if (tree !== slot.resultTree) fail(`snapshot output digest mismatch at ${slot.commit}`);
    reportProgress("verifying", index + 1, slotCount);
    return { slot, entries, raw, tree };
  });
  if (prepared.at(-1)?.slot.resultTree !== manifest.sourceTree)
    fail(
      "final full tree must equal frozen source; test/harness differences also require reconciliation",
    );
  // Preview every rewritten object so census/signature expectations fail before object writes.
  // Reuses the `tree` already built (write=false) above: same `entries`, untouched since.
  let previewParent = manifest.base;
  const preview = prepared.map(({ slot, raw, tree }, index) => {
    const rewritten = rebuildCommit(raw, tree, previewParent);
    previewParent = objects.hash("commit", rewritten.bytes, false);
    reportProgress("previewing", index + 1, slotCount);
    return { slot, tree, rebuilt: previewParent, rewritten };
  });
  for (const { slot, tree } of preview)
    if ((tree !== slot.tree) !== slot.changes.length > 0)
      fail(`rewrite change declarations disagree with tree result at ${slot.commit}`);
  const changedSlots = preview.filter(({ slot }) => slot.resultTree !== slot.tree).length;
  const removedSignatures = preview.filter(
    ({ rewritten }) => rewritten.removedSignatureSha256 !== null,
  ).length;
  if (
    changedSlots !== manifest.expected.changedSlots ||
    preview.length - changedSlots !== manifest.expected.unchangedSlots ||
    removedSignatures !== manifest.expected.removedSignatures
  )
    fail(
      `rewrite census mismatch: expected ${manifest.expected.changedSlots} changed, ${manifest.expected.unchangedSlots} unchanged and ${manifest.expected.removedSignatures} removed signatures; got ${changedSlots}, ${preview.length - changedSlots} and ${removedSignatures}`,
    );
  // No object writes until every snapshot, final-tree and census precondition passed.
  let parent = manifest.base;
  const slots = prepared.map(({ slot, entries, raw }, index) => {
    const tree = buildTree(objects, entries, writeObjects);
    const rewritten = rebuildCommit(raw, tree, parent);
    const rebuilt = objects.hash("commit", rewritten.bytes, writeObjects);
    if (rebuilt !== preview[index]!.rebuilt)
      fail("written rewrite object differs from preflight construction");
    if (!objects.git(["cat-file", "commit", rebuilt]).equals(rewritten.bytes))
      fail("commit readback changed bytes");
    parent = rebuilt;
    reportProgress("writing", index + 1, slotCount);
    return {
      original: slot.commit,
      rebuilt,
      tree,
      treeChanged: tree !== slot.tree,
      changedPaths: slot.changes.map((row) => row.path),
      removedSignatureSha256: rewritten.removedSignatureSha256,
    };
  });
  checkSource();
  return {
    schema: REWRITE_RECEIPT_SCHEMA,
    manifestSha256: NodeCrypto.createHash("sha256").update(rawManifest).digest("hex"),
    source: manifest.source,
    base: manifest.base,
    baseTag: manifest.baseTag,
    result: parent,
    finalTree: manifest.sourceTree,
    slots,
  };
};

const requireRewriteArtifacts = (
  root: string,
  manifest: string,
  receipt: string,
  requireReceipt: boolean,
) => {
  requireConsistentGitConfig();
  const manifestPath = NodePath.resolve(root, manifest);
  const receiptPath = NodePath.resolve(root, receipt);
  for (const file of [manifestPath, receiptPath]) {
    try {
      externalPath(root, file);
      externalPath(
        root,
        NodePath.join(NodeFS.realpathSync(NodePath.dirname(file)), NodePath.basename(file)),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    let stat: NodeFS.Stats | undefined;
    try {
      stat = NodeFS.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const required = file === manifestPath || requireReceipt;
    if ((stat === undefined && required) || (stat !== undefined && !stat.isFile()))
      fail("rewrite manifest and receipt must be regular external files");
  }
  return { manifestPath, receiptPath };
};

const requireProofArtifacts = (
  root: string,
  manifestPath: string,
  manifest: RewriteManifest,
): void => {
  const directory = NodePath.dirname(manifestPath);
  for (const proof of manifest.proofs) {
    const file = NodePath.resolve(directory, proof.artifact);
    try {
      externalPath(root, file);
      externalPath(
        root,
        NodePath.join(NodeFS.realpathSync(NodePath.dirname(file)), NodePath.basename(file)),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        fail(`missing rewrite proof artifact: ${proof.name}`);
      throw error;
    }
    if (!stat.isFile()) fail(`rewrite proof artifact must be a regular file: ${proof.name}`);
    const bytes = NodeFS.readFileSync(file);
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== proof.sha256) fail(`rewrite proof artifact digest mismatch: ${proof.name}`);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`invalid rewrite proof artifact: ${proof.name}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      fail(`invalid rewrite proof artifact: ${proof.name}`);
    const record = value as Record<string, unknown>;
    if (
      record.schema !== "fork.rewrite-proof.v1" ||
      record.name !== proof.name ||
      record.source !== manifest.source ||
      record.verdict !== "pass"
    )
      fail(`rewrite proof artifact did not attest this source: ${proof.name}`);
  }
};

/** Revalidate external artifacts before reading Git, then recompute their complete receipt. */
export const verifyRewriteBuild = (
  root: string,
  manifestPath: string,
  receiptPath: string,
): RewriteBuildReceipt => {
  const paths = requireRewriteArtifacts(root, manifestPath, receiptPath, true);
  const rawManifest = NodeFS.readFileSync(paths.manifestPath);
  requireProofArtifacts(
    root,
    paths.manifestPath,
    parseRewriteManifest(JSON.parse(rawManifest.toString("utf8"))),
  );
  const expected = buildRewrite(root, rawManifest, false);
  requireProofArtifacts(
    root,
    paths.manifestPath,
    parseRewriteManifest(JSON.parse(rawManifest.toString("utf8"))),
  );
  const actual: unknown = JSON.parse(NodeFS.readFileSync(paths.receiptPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail("rewrite receipt does not match verified manifest/objects");
  return expected;
};

export const runRewriteBuild = (argv: ReadonlyArray<string>, resolveRoot: () => string): number => {
  const json = argv.includes("--json");
  try {
    let manifestPath: string | undefined;
    let seenJson = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === "--json" && !seenJson) {
        seenJson = true;
        continue;
      }
      if (
        argv[index] !== "--manifest" ||
        manifestPath !== undefined ||
        !argv[index + 1] ||
        argv[index + 1]!.startsWith("--")
      )
        throw new UsageError("rewrite-build --manifest <reviewed-json> [--json]");
      manifestPath = argv[++index]!;
    }
    if (!manifestPath) throw new UsageError("--manifest is required");
    requireConsistentGitConfig();
    const root = resolveRoot();
    const paths = requireRewriteArtifacts(
      root,
      manifestPath,
      `${manifestPath}.receipt.json`,
      false,
    );
    manifestPath = paths.manifestPath;
    const receiptPath = paths.receiptPath;
    const rawManifest = NodeFS.readFileSync(manifestPath);
    requireProofArtifacts(
      root,
      manifestPath,
      parseRewriteManifest(JSON.parse(rawManifest.toString("utf8"))),
    );
    const manifest = parseRewriteManifest(JSON.parse(rawManifest.toString("utf8")));
    const receipt = buildRewrite(root, rawManifest);
    requireProofArtifacts(root, manifestPath, manifest);
    const bytes = JSON.stringify(receipt, null, 2) + "\n";
    if (NodeFS.existsSync(receiptPath)) {
      if (
        !NodeFS.lstatSync(receiptPath).isFile() ||
        NodeFS.readFileSync(receiptPath, "utf8") !== bytes
      )
        fail(
          "receipt already exists with different contents; retain it and use a new manifest path",
        );
    } else NodeFS.writeFileSync(receiptPath, bytes, { flag: "wx", mode: 0o600 });
    process.stdout.write(
      json
        ? JSON.stringify({ ...receipt, receiptPath }) + "\n"
        : `rewrite built: ${receipt.result}; ${receipt.slots.length} slots; exact final tree\nreceipt: ${receiptPath}\n`,
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof UsageError || error instanceof SyntaxError
        ? 2
        : error instanceof RewritePreconditionError
          ? 3
          : 1;
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      process.stdout.write(
        JSON.stringify({ schema: REWRITE_RECEIPT_SCHEMA, error: message, exitCode: code }) + "\n",
      );
    else process.stderr.write(`rewrite-build refused: ${message}\n`);
    return code;
  }
};
