// @effect-diagnostics nodeBuiltinImport:off - Bot-owned refs are Git plumbing; fixtures need real repositories.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  publishRerereSnapshot,
  resolveBotRef,
  restoreRerereCache,
  RERERE_REF,
  saveRerereCache,
} from "./fork-bot-refs.ts";
import { runCommand, runCommandText } from "./fork-command.ts";

const repository = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-bot-refs-test-"));
  runCommandText("git", ["init", "--quiet", "--initial-branch", "hyprws", root], { cwd: root });
  runCommandText("git", ["config", "user.email", "fork@example.invalid"], { cwd: root });
  runCommandText("git", ["config", "user.name", "fork"], { cwd: root });
  return root;
};

const withRepository = (effect: (root: string) => void): void => {
  const root = repository();
  try {
    effect(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

/** Read one path out of the local `refs/fork/rerere` tree; `null` when either is absent. */
const readRerereFile = (root: string, path: string): string | null => {
  const result = runCommand("git", ["show", `${RERERE_REF}:${path}`], { cwd: root });
  return result.status === 0 ? result.stdout : null;
};

const cacheEntry = (root: string, key: string, resolution: string): string => {
  const directory = NodePath.join(root, ".git", "rr-cache", key);
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "preimage"), "conflict\n");
  NodeFS.writeFileSync(NodePath.join(directory, "postimage"), resolution);
  return saveRerereCache(root, "rerere: test snapshot")!;
};

const lockfileCacheEntry = (root: string, key: string, resolution: string): string => {
  const directory = NodePath.join(root, ".git", "rr-cache", key);
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "preimage"), "lockfileVersion: '9.0'\n");
  NodeFS.writeFileSync(NodePath.join(directory, "postimage"), resolution);
  return saveRerereCache(root, "rerere: test snapshot")!;
};

const withPublishers = (effect: (left: string, right: string, remote: string) => void): void => {
  withRepository((left) =>
    withRepository((right) => {
      const remote = NodePath.join(left, "remote.git");
      runCommandText("git", ["init", "--quiet", "--bare", remote], { cwd: left });
      for (const root of [left, right])
        runCommandText("git", ["remote", "add", "origin", remote], { cwd: root });
      effect(left, right, remote);
    }),
  );
};

const leasedPush = (root: string, commit: string, expectedOld: string): void => {
  runCommandText(
    "git",
    [
      "push",
      "--quiet",
      `--force-with-lease=${RERERE_REF}:${expectedOld}`,
      "origin",
      `${commit}:${RERERE_REF}`,
    ],
    { cwd: root },
  );
};

it("retries a lost lease while retaining both publishers' independent resolutions", () => {
  withPublishers((left, right, remote) => {
    const snapshot = cacheEntry(left, "left", "left resolution\n");
    const competing = cacheEntry(right, "right", "right resolution\n");
    let pushes = 0;
    const leases: string[] = [];
    const published = publishRerereSnapshot(left, snapshot, (root, commit, expectedOld) => {
      leases.push(expectedOld);
      if (++pushes === 1) publishRerereSnapshot(right, competing);
      leasedPush(root, commit, expectedOld);
    });
    assert.strictEqual(pushes, 2);
    assert.strictEqual(leases[0], "");
    assert.match(leases[1]!, /^[a-f0-9]{40}$/);
    assert.strictEqual(readRerereFile(remote, "left/postimage"), "left resolution\n");
    assert.strictEqual(readRerereFile(remote, "right/postimage"), "right resolution\n");
    assert.strictEqual(publishRerereSnapshot(left, snapshot), published);
  });
});

it("refuses same-key disagreement without overwriting either resolution", () => {
  withPublishers((left, right, remote) => {
    const snapshot = cacheEntry(left, "same", "left resolution\n");
    const existing = publishRerereSnapshot(right, cacheEntry(right, "same", "right resolution\n"));
    assert.throws(
      () => publishRerereSnapshot(left, snapshot),
      /resolution disagreement at same\/postimage/,
    );
    assert.strictEqual(resolveBotRef(remote, RERERE_REF), existing);
    assert.strictEqual(readRerereFile(left, "same/postimage"), "left resolution\n");
  });
});

const variantFiles = (root: string, key: string, files: Record<string, string>): string => {
  const directory = NodePath.join(root, ".git", "rr-cache", key);
  NodeFS.mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files))
    NodeFS.writeFileSync(NodePath.join(directory, name), content);
  return saveRerereCache(root, "rerere: test snapshot")!;
};

it("opens a new variant when the same key already holds a different preimage", () => {
  withPublishers((left, right, remote) => {
    // The rr-cache id hashes only the conflict hunks, so the same seam under a moved
    // context reaches the shared ref as the same key with a different preimage. Git
    // numbers such variants per clone; the run that resolved it is not overwritten
    // and not refused.
    publishRerereSnapshot(right, variantFiles(right, "seam", { preimage: "older context\n" }));
    const snapshot = variantFiles(left, "seam", {
      preimage: "newer context\n",
      postimage: "resolved\n",
    });
    assert.match(publishRerereSnapshot(left, snapshot), /^[a-f0-9]{40}$/);
    assert.strictEqual(readRerereFile(remote, "seam/preimage"), "older context\n");
    assert.strictEqual(readRerereFile(remote, "seam/postimage"), null);
    assert.strictEqual(readRerereFile(remote, "seam/preimage.1"), "newer context\n");
    assert.strictEqual(readRerereFile(remote, "seam/postimage.1"), "resolved\n");
  });
});

it("fills the shared variant whose preimage the resolution matches", () => {
  withPublishers((left, right, remote) => {
    // Earlier stopped runs published the seam as unresolved variants; a local
    // clone numbers its own sighting 0. The resolution lands beside the matching
    // preimage instead of contending with variant 0, and a second run that
    // resolves it the same way is a no-op rather than a disagreement.
    publishRerereSnapshot(
      right,
      variantFiles(right, "seam", {
        preimage: "older context\n",
        "preimage.1": "other context\n",
        "preimage.2": "newer context\n",
      }),
    );
    const snapshot = variantFiles(left, "seam", {
      preimage: "newer context\n",
      postimage: "resolved\n",
    });
    const published = publishRerereSnapshot(left, snapshot);
    assert.strictEqual(readRerereFile(remote, "seam/postimage.2"), "resolved\n");
    assert.strictEqual(readRerereFile(remote, "seam/postimage"), null);
    assert.strictEqual(readRerereFile(remote, "seam/preimage.3"), null);
    assert.strictEqual(publishRerereSnapshot(left, snapshot), published);
    const contested = variantFiles(right, "seam", {
      preimage: "newer context\n",
      postimage: "resolved differently\n",
    });
    assert.throws(
      () => publishRerereSnapshot(right, contested),
      /resolution disagreement at seam\/postimage\.2/,
    );
    assert.strictEqual(resolveBotRef(remote, RERERE_REF), published);
  });
});

it("never publishes a regenerated lockfile entry and never calls it a disagreement", () => {
  withPublishers((left, right, remote) => {
    const notes: string[] = [];
    const logged = console.log;
    console.log = (line: string) => notes.push(line);
    try {
      // Two runs regenerate the lockfile with different resolved versions, so the same
      // rr-cache id carries disagreeing postimages that publication must skip, not fail on.
      publishRerereSnapshot(right, lockfileCacheEntry(right, "a".repeat(40), "resolved v1\n"));
      notes.length = 0;
      const published = publishRerereSnapshot(
        left,
        lockfileCacheEntry(left, "a".repeat(40), "resolved v2\n"),
      );
      // A real resolution from the same run still lands alongside the skipped entry.
      // Drop the local lockfile entry so the follow-up snapshot carries only the real one.
      NodeFS.rmSync(NodePath.join(left, ".git", "rr-cache", "a".repeat(40)), {
        recursive: true,
        force: true,
      });
      const snapshot = cacheEntry(left, "b".repeat(40), "human resolution\n");
      assert.match(publishRerereSnapshot(left, snapshot), /^[a-f0-9]{40}$/);
    } finally {
      console.log = logged;
    }
    assert.deepStrictEqual(notes, [
      `note: skipping regenerated lockfile rerere entry ${"a".repeat(40)}/postimage`,
    ]);
    assert.strictEqual(
      readRerereFile(remote, `${"a".repeat(40)}/postimage`),
      null,
      "the regenerated lockfile must never enter the shared rerere ref",
    );
    assert.strictEqual(readRerereFile(remote, `${"b".repeat(40)}/postimage`), "human resolution\n");
  });
});

it("restore never replays a shared lockfile entry into the local rr-cache", () => {
  withRepository((root) => {
    const key = "c".repeat(40);
    // The ref tree carries the stale postimage a plain read-tree would check out.
    const preimageBlob = runCommandText("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "lockfileVersion: '9.0'\n",
    }).trim();
    const postimageBlob = runCommandText("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "resolved on an older run\n",
    }).trim();
    const subtree = runCommandText("git", ["mktree"], {
      cwd: root,
      input: `100644 blob ${preimageBlob}\tpreimage\n100644 blob ${postimageBlob}\tpostimage\n`,
    }).trim();
    const tree = runCommandText("git", ["mktree"], {
      cwd: root,
      input: `040000 tree ${subtree}\t${key}\n`,
    }).trim();
    const commit = runCommandText("git", ["commit-tree", tree, "-m", "rerere"], {
      cwd: root,
    }).trim();
    runCommandText("git", ["update-ref", RERERE_REF, commit], { cwd: root });
    const notes: string[] = [];
    const logged = console.log;
    console.log = (line: string) => notes.push(line);
    try {
      assert.strictEqual(restoreRerereCache(root), true);
    } finally {
      console.log = logged;
    }
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(root, ".git", "rr-cache")), []);
    assert.deepStrictEqual(notes, [
      `note: skipping regenerated lockfile rerere entry ${key}/postimage`,
    ]);
  });
});

it("bounds competing publication to three leases and keeps its snapshot resumable", () => {
  withPublishers((left, right, remote) => {
    const snapshot = cacheEntry(left, "pending", "pending resolution\n");
    let pushes = 0;
    assert.throws(
      () =>
        publishRerereSnapshot(left, snapshot, (root, commit, expectedOld) => {
          publishRerereSnapshot(
            right,
            cacheEntry(right, `racer${++pushes}`, `resolution ${pushes}\n`),
          );
          leasedPush(root, commit, expectedOld);
        }),
      /exhausted 3 leased attempts/,
    );
    assert.strictEqual(pushes, 3);
    assert.strictEqual(readRerereFile(remote, "pending/postimage"), null);
    publishRerereSnapshot(left, snapshot);
    for (const key of ["pending", "racer1", "racer2", "racer3"])
      assert.isNotNull(readRerereFile(remote, `${key}/postimage`));
  });
});

it("does not retry an unrelated push refusal or publish volatile thisimage files", () => {
  withPublishers((left) => {
    cacheEntry(left, "same", "resolution\n");
    NodeFS.writeFileSync(
      NodePath.join(left, ".git", "rr-cache", "same", "thisimage"),
      "volatile\n",
    );
    const snapshot = saveRerereCache(left, "rerere: volatile")!;
    let pushes = 0;
    assert.throws(
      () =>
        publishRerereSnapshot(left, snapshot, () => {
          pushes++;
          throw new Error("permission denied");
        }),
      /permission denied/,
    );
    assert.strictEqual(pushes, 1);
    const published = publishRerereSnapshot(left, snapshot);
    assert.strictEqual(
      runCommandText("git", ["ls-tree", "-r", "--name-only", published], { cwd: left }).includes(
        "thisimage",
      ),
      false,
    );
  });
});

it("accepts a successful push whose response was lost without another mutation", () => {
  withPublishers((left) => {
    const snapshot = cacheEntry(left, "key", "resolution\n");
    let pushes = 0;
    const published = publishRerereSnapshot(left, snapshot, (root, commit, expectedOld) => {
      pushes++;
      leasedPush(root, commit, expectedOld);
      throw new Error("response lost");
    });
    assert.strictEqual(pushes, 1);
    assert.strictEqual(publishRerereSnapshot(left, snapshot), published);
  });
});

it("round-trips the rerere cache through its bot-owned ref", () => {
  withRepository((root) => {
    assert.strictEqual(saveRerereCache(root, "rerere: empty"), null);
    assert.strictEqual(restoreRerereCache(root), false);

    const cache = NodePath.join(root, ".git", "rr-cache");
    NodeFS.mkdirSync(NodePath.join(cache, "abc123"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cache, "abc123", "preimage"), "left\n");
    NodeFS.writeFileSync(NodePath.join(cache, "abc123", "postimage"), "resolved\n");
    assert.notStrictEqual(saveRerereCache(root, "rerere: v1"), null);

    NodeFS.rmSync(cache, { recursive: true, force: true });
    assert.strictEqual(restoreRerereCache(root), true);
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(cache, "abc123", "postimage"), "utf8"),
      "resolved\n",
    );
    assert.notStrictEqual(resolveBotRef(root, RERERE_REF), null);
  });
});
