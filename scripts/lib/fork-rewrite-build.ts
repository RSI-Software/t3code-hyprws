// @effect-diagnostics nodeBuiltinImport:off - Binary Git plumbing for an offline, object-only constructor.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { UsageError } from "./fork-cli.ts";

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
interface RewriteChange {
  readonly path: string;
  readonly before: RewriteEntry | null;
  readonly after: RewriteEntry | null;
  readonly reason: string;
}
interface RewriteSlot {
  readonly commit: string;
  readonly tree: string;
  readonly resultTree: string;
  readonly readSet: ReadonlyArray<ReadEntry>;
  readonly changes: ReadonlyArray<RewriteChange>;
}
export interface RewriteManifest {
  readonly schema: typeof REWRITE_MANIFEST_SCHEMA;
  readonly source: string;
  readonly sourceTree: string;
  readonly base: string;
  readonly baseTag: string;
  /** Reviewed proof artifacts, not checks executed by this constructor. */
  readonly proofs: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
  readonly unresolved: ReadonlyArray<string>;
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
export const parseRewriteManifest = (input: unknown): RewriteManifest => {
  const value = object(input, [
    "schema",
    "source",
    "sourceTree",
    "base",
    "baseTag",
    "proofs",
    "unresolved",
    "slots",
  ]);
  if (value.schema !== REWRITE_MANIFEST_SCHEMA)
    throw new UsageError(
      "expected executable fork.rewrite-manifest.v1; design inputs cannot execute",
    );
  const unresolved = array(value.unresolved).map(text);
  if (unresolved.length > 0) fail(`unresolved rewrite proof gates: ${unresolved.join(", ")}`);
  const proofs = array(value.proofs).map((input) => {
    const proof = object(input, ["name", "sha256"]);
    const digest = text(proof.sha256);
    if (!DIGEST.test(digest)) throw new UsageError("proof requires SHA-256 artifact digest");
    return { name: text(proof.name), sha256: digest };
  });
  for (const name of ["snapshot-tests", "composition", "test-ownership", "compatibility"])
    if (proofs.filter((proof) => proof.name === name).length !== 1)
      fail(`exactly one reviewed ${name} proof is required`);
  if (new Set(proofs.map((proof) => proof.name)).size !== proofs.length)
    throw new UsageError("duplicate rewrite proof name");
  const slots = array(value.slots).map((input): RewriteSlot => {
    const slot = object(input, ["commit", "tree", "resultTree", "readSet", "changes"]);
    const readSet = array(slot.readSet).map((input) => {
      const read = object(input, ["path", "entry"]);
      return { path: path(read.path), entry: entry(read.entry) };
    });
    const changes = array(slot.changes).map((input) => {
      const change = object(input, ["path", "before", "after", "reason"]);
      return {
        path: path(change.path),
        before: entry(change.before),
        after: entry(change.after),
        reason: text(change.reason),
      };
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
    unresolved,
    slots,
  };
};

/** No shell, index, replacement refs, network, or ref-update commands. */
export class RewriteObjects {
  private readonly known = new Set<string>();
  readonly root: string;
  constructor(root: string) {
    this.root = root;
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
          return type === "tree" ? [] : [[path(line.slice(tab + 1)), entry({ mode, type, oid })!]];
        }),
    );
  }
}
const sameEntry = (left: RewriteEntry | null, right: RewriteEntry | null): boolean =>
  left === null || right === null
    ? left === right
    : left.mode === right.mode && left.type === right.type && left.oid === right.oid;

/** Tree ordering compares directories with their trailing slash, as Git does. */
const buildTree = (
  objects: RewriteObjects,
  entries: ReadonlyMap<string, RewriteEntry>,
  write: boolean,
): string => {
  const build = (prefix: string): string => {
    const children = new Map<string, RewriteEntry | null>();
    for (const [name, item] of entries) {
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length),
        slash = relative.indexOf("/");
      const child = slash === -1 ? relative : relative.slice(0, slash);
      const current = children.get(child);
      if (current !== undefined && (current === null) !== (slash !== -1))
        fail(`file/directory collision at ${prefix}${child}`);
      children.set(child, slash === -1 ? item : null);
    }
    const chunks = [...children]
      .map(([name, item]) => ({
        name,
        directory: item === null,
        mode: item?.mode ?? "40000",
        oid: item?.oid ?? build(`${prefix}${name}/`),
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
  return build("");
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
  let originalParent = manifest.base;
  const prepared = manifest.slots.map((slot) => {
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
    return { slot, entries, raw };
  });
  if (prepared.at(-1)?.slot.resultTree !== manifest.sourceTree)
    fail(
      "final full tree must equal frozen source; test/harness differences also require reconciliation",
    );
  // No object writes until every snapshot and final-tree precondition passed.
  let parent = manifest.base;
  const slots = prepared.map(({ slot, entries, raw }) => {
    const tree = buildTree(objects, entries, writeObjects);
    const rewritten = rebuildCommit(raw, tree, parent);
    const rebuilt = objects.hash("commit", rewritten.bytes, writeObjects);
    if (!objects.git(["cat-file", "commit", rebuilt]).equals(rewritten.bytes))
      fail("commit readback changed bytes");
    parent = rebuilt;
    return {
      original: slot.commit,
      rebuilt,
      tree,
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

/** Recompute every receipt field from the frozen manifest and existing objects without writing. */
export const verifyRewriteBuild = (
  root: string,
  manifestPath: string,
  receiptPath: string,
): RewriteBuildReceipt => {
  const expected = buildRewrite(root, NodeFS.readFileSync(manifestPath), false);
  const actual: unknown = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail("rewrite receipt does not match verified manifest/objects");
  return expected;
};

export const runRewriteBuild = (argv: ReadonlyArray<string>, root: string): number => {
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
      manifestPath = NodePath.resolve(root, argv[++index]!);
    }
    if (!manifestPath) throw new UsageError("--manifest is required");
    const receipt = buildRewrite(root, NodeFS.readFileSync(manifestPath));
    const receiptPath = `${manifestPath}.receipt.json`;
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
