// @effect-diagnostics nodeBuiltinImport:off - Bot-owned refs are Git plumbing; fixtures need real repositories.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  CHURN_LEDGER_FILE,
  CHURN_REF,
  RERERE_REF,
  publishRerereSnapshot,
  readBotRefFile,
  resolveBotRef,
  restoreRerereCache,
  saveRerereCache,
  writeBotRefFile,
} from "./fork-bot-refs.ts";
import { runCommandText } from "./fork-command.ts";

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

it("appends to a bot-owned ref without touching the working tree", () => {
  withRepository((root) => {
    assert.strictEqual(resolveBotRef(root, CHURN_REF), null);
    const first = writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "churn: seed");
    assert.strictEqual(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE), "[]\n");

    // An unchanged tree is not a new commit, so a rerun of the report is a no-op.
    assert.strictEqual(
      writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "churn: seed"),
      first,
    );

    const second = writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, '["v1"]\n', "churn: v1");
    assert.notStrictEqual(second, first);
    assert.strictEqual(
      runCommandText("git", ["rev-parse", `${CHURN_REF}~1`], { cwd: root }).trim(),
      first,
    );
    assert.deepStrictEqual(NodeFS.readdirSync(root), [".git"]);
  });
});

const cacheEntry = (root: string, key: string, resolution: string): string => {
  const directory = NodePath.join(root, ".git", "rr-cache", key);
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "preimage"), "conflict\n");
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
    assert.strictEqual(readBotRefFile(remote, RERERE_REF, "left/postimage"), "left resolution\n");
    assert.strictEqual(readBotRefFile(remote, RERERE_REF, "right/postimage"), "right resolution\n");
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
    assert.strictEqual(readBotRefFile(left, RERERE_REF, "same/postimage"), "left resolution\n");
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
    assert.strictEqual(readBotRefFile(remote, RERERE_REF, "pending/postimage"), null);
    publishRerereSnapshot(left, snapshot);
    for (const key of ["pending", "racer1", "racer2", "racer3"])
      assert.isNotNull(readBotRefFile(remote, RERERE_REF, `${key}/postimage`));
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
