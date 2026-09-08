// @effect-diagnostics nodeBuiltinImport:off - Bot-owned refs are Git plumbing; fixtures need real repositories.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  acquireBotRefLease,
  CHURN_LEDGER_FILE,
  CHURN_REF,
  publishBotRefLease,
  pushBotRef,
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

// Every mutating ledger write leases the ref origin advertises, so an existing checkout
// appends to an advanced ledger instead of failing the same lease forever (#631).

const headOf = (root: string, ref = CHURN_REF): string =>
  runCommandText("git", ["rev-parse", ref], { cwd: root }).trim();

const seedPublishedLedger = (publisher: string, contents = "[]\n"): string => {
  const commit = writeBotRefFile(publisher, CHURN_REF, CHURN_LEDGER_FILE, contents, "churn: seed");
  pushBotRef(publisher, CHURN_REF);
  return commit;
};

it("leases the published ledger from a checkout holding a stale local ref", () => {
  withPublishers((publisher, consumer, remote) => {
    const seeded = seedPublishedLedger(publisher);
    assert.strictEqual(resolveBotRef(consumer, CHURN_REF), seeded);
    const advanced = writeBotRefFile(
      publisher,
      CHURN_REF,
      CHURN_LEDGER_FILE,
      '["v1"]\n',
      "churn: v1",
    );
    pushBotRef(publisher, CHURN_REF);

    const lease = acquireBotRefLease(consumer, CHURN_REF, true);
    assert.deepStrictEqual(lease, { ref: CHURN_REF, expectedOld: advanced, base: advanced });
    // The write now reads the concurrent walk rather than the head the checkout cached.
    assert.strictEqual(readBotRefFile(consumer, CHURN_REF, CHURN_LEDGER_FILE), '["v1"]\n');
    const appended = writeBotRefFile(
      consumer,
      CHURN_REF,
      CHURN_LEDGER_FILE,
      '["v1","v2"]\n',
      "churn: v2",
    );
    publishBotRefLease(consumer, lease!, appended);
    assert.strictEqual(readBotRefFile(remote, CHURN_REF, CHURN_LEDGER_FILE), '["v1","v2"]\n');
  });
});

it("creates the local ref from origin when the checkout has never seen the ledger", () => {
  withPublishers((publisher, consumer) => {
    const seeded = seedPublishedLedger(publisher, '["v1"]\n');
    const lease = acquireBotRefLease(consumer, CHURN_REF, true);
    assert.deepStrictEqual(lease, { ref: CHURN_REF, expectedOld: seeded, base: seeded });
    assert.strictEqual(headOf(consumer), seeded);
  });
});

it("retains an unpushed local append and leases it against the published head", () => {
  withPublishers((publisher, consumer, remote) => {
    const seeded = seedPublishedLedger(publisher);
    assert.strictEqual(resolveBotRef(consumer, CHURN_REF), seeded);
    const pending = writeBotRefFile(
      consumer,
      CHURN_REF,
      CHURN_LEDGER_FILE,
      '["pending"]\n',
      "churn: pending",
    );

    const lease = acquireBotRefLease(consumer, CHURN_REF, true);
    assert.deepStrictEqual(lease, { ref: CHURN_REF, expectedOld: seeded, base: pending });
    publishBotRefLease(consumer, lease!, pending);
    assert.strictEqual(readBotRefFile(remote, CHURN_REF, CHURN_LEDGER_FILE), '["pending"]\n');
  });
});

it("fails closed when origin moves between the lease and the push, then succeeds on a rerun", () => {
  withPublishers((publisher, consumer, remote) => {
    const seeded = seedPublishedLedger(publisher);
    assert.strictEqual(resolveBotRef(consumer, CHURN_REF), seeded);
    const lease = acquireBotRefLease(consumer, CHURN_REF, true)!;
    const local = writeBotRefFile(
      consumer,
      CHURN_REF,
      CHURN_LEDGER_FILE,
      '["consumer"]\n',
      "churn: consumer",
    );
    const rival = writeBotRefFile(
      publisher,
      CHURN_REF,
      CHURN_LEDGER_FILE,
      '["rival"]\n',
      "churn: rival",
    );
    pushBotRef(publisher, CHURN_REF);

    assert.throws(
      () => publishBotRefLease(consumer, lease, local),
      new RegExp(`local=${local}, remote=${rival}, expected=${seeded}`),
    );
    assert.strictEqual(headOf(consumer), seeded);
    assert.strictEqual(readBotRefFile(remote, CHURN_REF, CHURN_LEDGER_FILE), '["rival"]\n');

    const retry = acquireBotRefLease(consumer, CHURN_REF, true)!;
    assert.strictEqual(retry.expectedOld, rival);
    const merged = writeBotRefFile(
      consumer,
      CHURN_REF,
      CHURN_LEDGER_FILE,
      '["rival","consumer"]\n',
      "churn: consumer",
    );
    publishBotRefLease(consumer, retry, merged);
    assert.strictEqual(
      readBotRefFile(remote, CHURN_REF, CHURN_LEDGER_FILE),
      '["rival","consumer"]\n',
    );
  });
});

it("fails closed on an absent, unreachable or diverged published ledger", () => {
  withPublishers((publisher, consumer, remote) => {
    // Never seeded anywhere: the caller reports its own seeding instruction.
    assert.strictEqual(acquireBotRefLease(consumer, CHURN_REF, true), null);

    const local = writeBotRefFile(consumer, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "churn: local");
    assert.throws(
      () => acquireBotRefLease(consumer, CHURN_REF, true),
      new RegExp(`absent on origin.*local=${local}, remote=unknown, expected=none`),
    );
    assert.strictEqual(headOf(consumer), local);

    const published = seedPublishedLedger(publisher, '["published"]\n');
    assert.throws(
      () => acquireBotRefLease(consumer, CHURN_REF, true),
      new RegExp(`diverged.*local=${local}, remote=${published}, expected=${published}`),
    );
    assert.strictEqual(headOf(consumer), local);
    assert.strictEqual(readBotRefFile(remote, CHURN_REF, CHURN_LEDGER_FILE), '["published"]\n');

    runCommandText("git", ["remote", "set-url", "origin", NodePath.join(consumer, "gone.git")], {
      cwd: consumer,
    });
    assert.throws(
      () => acquireBotRefLease(consumer, CHURN_REF, true),
      /could not be read from origin/,
    );
    assert.strictEqual(headOf(consumer), local);
  });
});

it("keeps the local-writer contract when the write is not published", () => {
  withRepository((root) => {
    assert.strictEqual(acquireBotRefLease(root, CHURN_REF, false), null);
    const local = writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "churn: local");
    assert.deepStrictEqual(acquireBotRefLease(root, CHURN_REF, false), {
      ref: CHURN_REF,
      expectedOld: local,
      base: local,
    });
  });
});
