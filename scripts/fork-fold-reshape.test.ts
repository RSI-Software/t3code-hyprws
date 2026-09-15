// @effect-diagnostics nodeBuiltinImport:off - Exercise derivation against isolated Git repositories.
// @effect-diagnostics preferSchemaOverJson:off - The constructor consumes raw manifest bytes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { deriveFoldManifest, type FoldGit } from "./lib/fork-fold-reshape.ts";
import { buildRewrite } from "./lib/fork-rewrite-build.ts";

const git = (root: string, args: ReadonlyArray<string>, input?: string): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd: root, input, encoding: "utf8" });
const commitAll = (root: string, message: string): string => {
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
};
const writeFiles = (root: string, files: Record<string, string>): void => {
  for (const [path, content] of Object.entries(files)) {
    const target = NodePath.join(root, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  }
};

interface Repo {
  readonly root: string;
  readonly base: string;
  readonly shas: ReadonlyArray<string>;
  readonly git: FoldGit;
}
const fixture = Effect.fn("foldFixture")(function* (
  commits: Array<{ message: string; files: Record<string, string> }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fold-reshape-" });
  const root = NodePath.join(directory, "repo");
  yield* fs.makeDirectory(root);
  git(root, ["init", "--quiet", "--initial-branch=fixture"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  writeFiles(root, { "lib.ts": "a\nb\nc\n", "other.ts": "x\n" });
  const base = commitAll(root, "base");
  git(root, ["tag", "v0.1.0"]);
  const shas: Array<string> = [];
  for (const step of commits) {
    writeFiles(root, step.files);
    shas.push(commitAll(root, step.message));
  }
  const source = shas[shas.length - 1]!;
  git(root, ["update-ref", "refs/remotes/origin/hyprws", source]);
  const runner: FoldGit = (args, input) => git(root, args, input);
  return { root, base, shas, git: runner };
});

const derive = (
  repo: Repo,
  source: string,
  reshapes: ReadonlyArray<string>,
  attribute?: ReadonlyMap<string, string>,
  leave?: ReadonlySet<string>,
) =>
  deriveFoldManifest({
    git: repo.git,
    base: repo.base,
    baseTag: "v0.1.0",
    source,
    reshapes: [...reshapes],
    ...(attribute === undefined ? {} : { attribute }),
    ...(leave === undefined ? {} : { leave }),
  });

it.layer(NodeServices.layer)("fold-reshape derivation", (it) => {
  it.effect("propagates the fold through every slot between origin and reshape", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: adds lib", files: { "lib.ts": "fork-line\nsep\nz\n" } },
        { message: "feat: edits lib elsewhere", files: { "lib.ts": "fork-line\nsep\nZ\n" } },
        { message: "reshape: fold the fork line", files: { "lib.ts": "folded-line\nsep\nZ\n" } },
      ]);
      const reshape = repo.shas[2]!;
      const result = derive(repo, reshape, [reshape]);
      assert.strictEqual("refused" in result, false, JSON.stringify(result));
      if (!("refused" in result)) {
        assert.strictEqual(result.expected.changedSlots, 2);
        assert.strictEqual(result.slots[2]!.changes.length, 0);
        const receipt = buildRewrite(repo.root, Buffer.from(JSON.stringify(result)));
        assert.strictEqual(receipt.finalTree, result.sourceTree);
        assert.strictEqual(receipt.slots[2]!.treeChanged, false);
        assert.strictEqual(receipt.slots[0]!.treeChanged, true);
        assert.strictEqual(receipt.slots[1]!.treeChanged, true);
        // The rebuilt reshape commit's diff on lib.ts must be empty: its rebuilt parent already
        // carries the folded blob.
        const libBlob = (treeish: string): string => {
          const row = git(repo.root, ["ls-tree", treeish, "--", "lib.ts"]);
          return row.trim().split(/\s+/)[2] ?? "";
        };
        const rebuiltReshapeTree = git(repo.root, [
          "log",
          "-1",
          "--format=%T",
          receipt.slots[2]!.rebuilt,
        ]).trim();
        const rebuiltParentTree = git(repo.root, [
          "log",
          "-1",
          "--format=%T",
          `${receipt.slots[2]!.rebuilt}^`,
        ]).trim();
        assert.strictEqual(libBlob(rebuiltParentTree), libBlob(rebuiltReshapeTree));
        assert.strictEqual(libBlob(rebuiltReshapeTree).length > 0, true);
      }
    }),
  );

  it.effect("refuses when the fold conflicts with a later edit on the same line", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: fork line", files: { "lib.ts": "fork-line\nz\n" } },
        { message: "feat: edits the next line", files: { "lib.ts": "fork-line\nZ\n" } },
        { message: "reshape: fold the fork line", files: { "lib.ts": "folded-line\nZ\n" } },
      ]);
      const reshape = repo.shas[2]!;
      const result = derive(repo, reshape, [reshape]);
      assert.strictEqual("refused" in result, true);
      if ("refused" in result)
        assert.include(result.reasons.join("\n"), "lib.ts: fold conflicts at");
    }),
  );

  it.effect("accepts --attribute for a new fork-only file blame cannot decide", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: fork commit", files: { "lib.ts": "a\nb\n" } },
        { message: "reshape: attach new fork file", files: { "feature.fork.ts": "hook\n" } },
      ]);
      const origin = repo.shas[0]!;
      const reshape = repo.shas[1]!;
      const bare = derive(repo, reshape, [reshape]);
      assert.strictEqual("refused" in bare, true);
      if ("refused" in bare)
        assert.include(bare.reasons.join("\n"), "no adjacent fork-blamed context");
      const result = derive(repo, reshape, [reshape], new Map([["feature.fork.ts", origin]]));
      assert.strictEqual("refused" in result, false, JSON.stringify(result));
      if (!("refused" in result)) {
        assert.strictEqual(result.expected.changedSlots, 1);
        assert.strictEqual(result.slots[0]!.changes[0]!.path, "feature.fork.ts");
        assert.strictEqual(result.slots[0]!.changes[0]!.before, null);
        const receipt = buildRewrite(repo.root, Buffer.from(JSON.stringify(result)));
        assert.strictEqual(receipt.finalTree, result.sourceTree);
      }
    }),
  );

  // Tree-ID equivalence oracle: apply the same changes through the Git index (read-tree +
  // update-index + write-tree) and compare with the derived resultTree.
  const writeTreeOf = (
    root: string,
    treeOid: string,
    changes: ReadonlyArray<{ path: string; mode?: string; oid: string | null }>,
  ): string => {
    const env = { ...process.env, GIT_INDEX_FILE: NodePath.join(root, ".tmp-fold-index") };
    const run = (args: ReadonlyArray<string>): string =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, env, encoding: "utf8" });
    run(["read-tree", treeOid]);
    for (const change of changes) {
      if (change.oid === null) run(["update-index", "--force-remove", change.path]);
      else
        run([
          "update-index",
          "--add",
          "--cacheinfo",
          `${change.mode ?? "100644"},${change.oid},${change.path}`,
        ]);
    }
    return run(["write-tree"]).trim();
  };
  const blobOf = (root: string, treeOid: string, path: string): string => {
    const row = NodeChildProcess.execFileSync("git", ["ls-tree", treeOid, "--", path], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return row.split(/\s+/)[2] ?? "";
  };

  it.effect("nested-path result tree equals the index-equivalent write-tree", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: adds nested file", files: { "deep/nested/hold.txt": "fold-me\n" } },
        { message: "feat: edits top file", files: { "other.ts": "x\nTOP\n" } },
        { message: "reshape: fold the nested line", files: { "deep/nested/hold.txt": "folded\n" } },
      ]);
      const reshape = repo.shas[2]!;
      const result = derive(repo, reshape, [reshape]);
      assert.strictEqual("refused" in result, false, JSON.stringify(result));
      if (!("refused" in result)) {
        const holdBlob = repo.git(["hash-object", "-w", "--stdin"], "folded\n").trim();
        for (const slot of result.slots) {
          if (slot.changes.length === 0) continue;
          const expected = writeTreeOf(repo.root, slot.tree, [
            { path: "deep/nested/hold.txt", oid: holdBlob },
          ]);
          assert.strictEqual(slot.resultTree, expected, `slot ${slot.commit}`);
        }
        const receipt = buildRewrite(repo.root, Buffer.from(JSON.stringify(result)));
        assert.strictEqual(receipt.finalTree, result.sourceTree);
      }
    }),
  );

  it.effect("deleted-path propagation matches the index-equivalent write-tree", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        {
          message: "feat: adds file and fork line",
          files: { "gone.txt": "vanish\n", "lib.ts": "a\nfork-line\nsep\nc\n" },
        },
        { message: "feat: edits elsewhere", files: { "other.ts": "x\nTOP\n" } },
        {
          message: "reshape: delete and fold",
          files: { "lib.ts": "a\nfolded-line\nsep\nc\n" },
        },
      ]);
      let reshape = repo.shas[2]!;
      NodeFS.unlinkSync(NodePath.join(repo.root, "gone.txt"));
      git(repo.root, ["add", "-A", "."]);
      git(repo.root, ["commit", "--quiet", "--amend", "--no-edit"]);
      reshape = git(repo.root, ["rev-parse", "HEAD"]).trim();
      git(repo.root, ["update-ref", "refs/remotes/origin/hyprws", reshape]);
      const result = derive(repo, reshape, [reshape]);
      assert.strictEqual("refused" in result, false, JSON.stringify(result));
      if (!("refused" in result)) {
        const libBlob = repo
          .git(["hash-object", "-w", "--stdin"], "a\nfolded-line\nsep\nc\n")
          .trim();
        const goneTree = writeTreeOf(repo.root, result.slots[0]!.tree, [
          { path: "lib.ts", oid: libBlob },
          { path: "gone.txt", oid: null },
        ]);
        assert.strictEqual(result.slots[0]!.resultTree, goneTree);
        assert.strictEqual(result.slots[0]!.changes.length, 2);
        assert.strictEqual(
          result.slots[0]!.changes.find((change) => change.path === "gone.txt")!.after,
          null,
        );
        const receipt = buildRewrite(repo.root, Buffer.from(JSON.stringify(result)));
        assert.strictEqual(receipt.finalTree, result.sourceTree);
      }
    }),
  );

  it.effect("git spawns stay within S x (depth + 4) for one changed nested file", () =>
    Effect.gen(function* () {
      // FOLD_SPAWN_BUDGET_PER_SLOT = depth + 4: per changed slot the fold costs one ls-tree per
      // ancestor directory plus one mktree per rebuilt directory (the depth term) and one
      // entryAt + merge-file + hash-object + tree rev-parse (the +4). A full-tree rebuild
      // (one spawn per directory of the whole repo, per changed slot) blows the budget.
      const filler: Array<{ message: string; files: Record<string, string> }> = [];
      for (let index = 0; index < 27; index++)
        filler.push({
          message: `feat: filler ${index}`,
          files: { [`dir-${index}/seed.txt`]: `seed ${index}\n`, "other.ts": `x\nv${index}\n` },
        });
      const repo = yield* fixture([
        {
          message: "feat: adds nested fold target",
          files: { "deep/nested/hold.txt": "fold-me\n" },
        },
        ...filler,
        { message: "reshape: fold the nested line", files: { "deep/nested/hold.txt": "folded\n" } },
      ]);
      const reshape = repo.shas[repo.shas.length - 1]!;
      const stackSize = Number(
        repo.git(["rev-list", "--count", `${repo.base}..${reshape}`]).trim(),
      );
      let spawns = 0;
      const countingGit: FoldGit = (args, input) => {
        spawns += 1;
        return repo.git(args, input);
      };
      const result = deriveFoldManifest({
        git: countingGit,
        base: repo.base,
        baseTag: "v0.1.0",
        source: reshape,
        reshapes: [reshape],
      });
      assert.strictEqual("refused" in result, false, JSON.stringify(result));
      if ("refused" in result) return;
      const depth = 2; // deep/nested/hold.txt
      const budget = stackSize * (depth + 4);
      assert.strictEqual(
        spawns <= budget,
        true,
        `FOLD_SPAWN_BUDGET_PER_SLOT: ${spawns} git spawns exceed stack ${stackSize} x (depth ${depth} + 4) = ${budget}; a full-tree rebuild must fail this bound`,
      );
      const receipt = buildRewrite(repo.root, Buffer.from(JSON.stringify(result)));
      assert.strictEqual(receipt.finalTree, result.sourceTree);
    }),
  );

  it.effect("--leave keeps a blame-refusing path in the reshape and folds the rest", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: fork line", files: { "lib.ts": "a\nB-fork\nc\n" } },
        {
          message: "reshape: folds lib, adds an unattributable file",
          files: { "lib.ts": "a\nB-fold\nc\n", "feature.fork.ts": "hook\n" },
        },
      ]);
      const reshape = repo.shas[1]!;
      const bare = derive(repo, reshape, [reshape]);
      assert.strictEqual("refused" in bare, true);
      const result = derive(repo, reshape, [reshape], undefined, new Set(["feature.fork.ts"]));
      assert.strictEqual("refused" in result, false, JSON.stringify(result));
      if (!("refused" in result)) {
        assert.strictEqual(result.expected.changedSlots, 1);
        assert.strictEqual(result.slots[0]!.changes[0]!.path, "lib.ts");
        assert.strictEqual(result.slots[1]!.changes.length, 0); // R survives as the residual.
        const receipt = buildRewrite(repo.root, Buffer.from(JSON.stringify(result)));
        assert.strictEqual(receipt.finalTree, result.sourceTree);
        // The left path stays in R's tree.
        assert.include(
          git(repo.root, ["ls-tree", receipt.slots[1]!.tree, "--", "feature.fork.ts"]),
          "feature.fork.ts",
        );
      }
    }),
  );

  it.effect("refuses a hunk that attributes to an upstream commit, by hunk name", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: fork line", files: { "lib.ts": "a\nB-fork\nc\n" } },
        { message: "reshape: touches upstream", files: { "lib.ts": "A-up\nB-fork\nc\n" } },
      ]);
      const reshape = repo.shas[1]!;
      const result = derive(repo, reshape, [reshape]);
      assert.strictEqual("refused" in result, true);
      if ("refused" in result) {
        assert.include(result.reasons.join("\n"), "lib.ts:1,+");
        assert.include(result.reasons.join("\n"), "outside base..source");
      }
    }),
  );

  it.effect("refuses a hunk whose removed lines blame to two fork commits, by hunk name", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: first fork line", files: { "lib.ts": "a\nB-fork\nc\n" } },
        { message: "feat: second fork line", files: { "lib.ts": "a\nB-fork\nC-fork\n" } },
        { message: "reshape: removes both fork lines", files: { "lib.ts": "a\nb\nc\n" } },
      ]);
      const reshape = repo.shas[2]!;
      const result = derive(repo, reshape, [reshape]);
      assert.strictEqual("refused" in result, true);
      if ("refused" in result)
        assert.include(result.reasons.join("\n"), "blames to two fork commits");
    }),
  );

  it.effect("batches two reshapes over two originating commits into one manifest", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: fork line", files: { "lib.ts": "a\nB-fork\nc\n" } },
        { message: "reshape: fold the fork line", files: { "lib.ts": "a\nB-fold\nc\n" } },
        { message: "feat: other fork line", files: { "other.ts": "x\nq-fork\n" } },
        { message: "reshape: fold the other fork line", files: { "other.ts": "x\nq-fold\n" } },
      ]);
      const reshapeOne = repo.shas[1]!;
      const reshapeTwo = repo.shas[3]!;
      const result = derive(repo, reshapeTwo, [reshapeOne, reshapeTwo]);
      assert.strictEqual("refused" in result, false, JSON.stringify(result));
      if (!("refused" in result)) {
        assert.strictEqual(result.expected.changedSlots, 2);
        assert.strictEqual(result.slots.length, 4);
        assert.strictEqual(result.slots[1]!.changes.length, 0);
        assert.strictEqual(result.slots[3]!.changes.length, 0);
        const receipt = buildRewrite(repo.root, Buffer.from(JSON.stringify(result)));
        assert.strictEqual(receipt.finalTree, result.sourceTree);
      }
    }),
  );

  it.effect("reads each slot tree once regardless of how many paths are attributed", () =>
    Effect.gen(function* () {
      const filler: Array<{ message: string; files: Record<string, string> }> = [];
      for (let index = 0; index < 11; index++)
        filler.push({
          message: `feat: filler ${index}`,
          files: { "lib.ts": `fork-a\nb\n${index}\n` },
        });
      const repo = yield* fixture([
        {
          message: "feat: forks two files",
          files: { "lib.ts": "fork-a\nb\nc\n", "other.ts": "fork-x\n" },
        },
        ...filler,
        {
          message: "reshape: folds both files",
          files: { "lib.ts": `fold-a\nb\n10\n`, "other.ts": "fold-x\n" },
        },
      ]);
      const reshape = repo.shas[repo.shas.length - 1]!;
      const slots = Number(repo.git(["rev-list", "--count", `${repo.base}..${reshape}`]).trim());
      let listings = 0;
      const countingGit: FoldGit = (args, input) => {
        if (args[0] === "ls-tree" && args.includes("--")) listings += 1; // path reads only
        return repo.git(args, input);
      };
      const result = deriveFoldManifest({
        git: countingGit,
        base: repo.base,
        baseTag: "v0.1.0",
        source: reshape,
        reshapes: [reshape],
      });
      assert.strictEqual("refused" in result, false, JSON.stringify(result));
      if ("refused" in result) return;
      // Both paths fold through every slot below the reshape. One `ls-tree` per distinct tree
      // answers both; a per-path read would cost at least 2 x (slots - 1) here.
      assert.strictEqual(
        listings <= slots + 1,
        true,
        `FOLD_TREE_READ_BUDGET: ${listings} ls-tree spawns for ${slots} slots x 2 paths`,
      );
      assert.strictEqual(result.expected.changedSlots, slots - 1);
    }),
  );

  it.effect("reports derive progress on stderr, and nothing under FORK_QUIET", () =>
    Effect.gen(function* () {
      const repo = yield* fixture([
        { message: "feat: fork line", files: { "lib.ts": "a\nB-fork\nc\n" } },
        { message: "feat: later edit", files: { "lib.ts": "a\nB-fork\nC\n" } },
        { message: "reshape: fold the fork line", files: { "lib.ts": "a\nB-fold\nC\n" } },
      ]);
      const reshape = repo.shas[2]!;
      const lines: Array<string> = [];
      const original = process.stderr.write.bind(process.stderr);
      const quiet = process.env.FORK_QUIET;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      }) as typeof process.stderr.write;
      try {
        delete process.env.FORK_QUIET;
        derive(repo, reshape, [reshape]);
        const loud = lines.filter((line) => line.startsWith("fold-reshape: ")).length;
        lines.length = 0;
        process.env.FORK_QUIET = "1";
        derive(repo, reshape, [reshape]);
        assert.strictEqual(loud > 0, true, "derive must report progress");
        assert.deepStrictEqual(
          lines.filter((line) => line.startsWith("fold-reshape: ")),
          [],
        );
      } finally {
        process.stderr.write = original;
        if (quiet === undefined) delete process.env.FORK_QUIET;
        else process.env.FORK_QUIET = quiet;
      }
    }),
  );
});
