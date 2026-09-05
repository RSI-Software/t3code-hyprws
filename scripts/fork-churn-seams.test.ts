// @effect-diagnostics nodeBuiltinImport:off - Disposable CLI repositories verify durable records and exit contracts.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  assessSeams,
  freezeObservation,
  requireSeamRecords,
  seamIdentity,
  seamRecord,
  type SeamRecord,
} from "./lib/fork-churn-seams.ts";
import {
  parseChurnState,
  readChurnState,
  writeChurnLedger,
  writeChurnState,
  type CensusSnapshot,
  type ChurnEntry,
} from "./fork-churn-ledger.ts";
import { run } from "./fork-churn.ts";
import { runCommandText } from "./lib/fork-command.ts";
import {
  CHURN_REF,
  CHURN_LEDGER_FILE,
  readBotRefFile,
  writeBotRefFile,
} from "./lib/fork-bot-refs.ts";

const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40),
  D = "d".repeat(40);
const attestation = { actor: "maintainer-agent", evidenceUrl: "https://example.test/review/1" };
const file = (path = "seam.ts", subject = "feat: preserve fork intent") => ({
  path,
  subject,
  domain: "fork-meta",
  commit: A,
  hunks: null,
});
const snapshot = (
  sourceSha: string,
  files = [file()],
  targetSha = C,
  complete = true,
): CensusSnapshot => ({
  tag: "v1.0.0",
  fixedAt: null,
  files,
  censusEvidence: {
    version: 1,
    method: "sequential-rebase-stage3-provisional",
    sourceSha,
    baseSha: D,
    targetSha,
    targetTag: "v1.0.0",
    complete,
    rows: files.map((row, index) => ({
      stop: index + 1,
      commit: row.commit,
      path: row.path,
      subject: row.subject,
      domain: row.domain,
      kind: "content",
    })),
  },
});
const before = seamRecord(freezeObservation(snapshot(A)));
const clear = seamRecord(freezeObservation(snapshot(B, [])));
const repair = seamRecord({
  kind: "repair",
  before: { observation: before.id, row: 0 },
  changeSha: B,
  guard: "fork seam fixture",
  attestation,
} as const);
const verification = seamRecord({
  kind: "verification",
  repair: repair.id,
  after: clear.id,
  guardProof: {
    sourceSha: B,
    command: "vp test run seam.fork.test.ts",
    exitCode: 0,
    output: "1 passed",
  },
  attestation,
} as const);
const records = [before, clear, repair, verification];
const walk = (tag: string, observed: CensusSnapshot): ChurnEntry => ({
  tag,
  before: A,
  after: B,
  recordUrl: "https://example.test/walk",
  conflicts: [],
  decisions: [],
  censusFiles: observed.files,
  ...(observed.censusEvidence === undefined ? {} : { censusEvidence: observed.censusEvidence }),
});

it("keeps absent and returned observations unresolved without inventing a repair", () => {
  const absent = assessSeams([snapshot(A), snapshot(B, [])], []);
  assert.strictEqual(absent[0]?.status, "not-observed");
  assert.isNull(absent[0]?.repairSha);
  assert.isFalse(absent[0]?.blocking);
  const returned = assessSeams([snapshot(A), snapshot(B, []), snapshot(C)], []);
  assert.strictEqual(returned[0]?.status, "returned-unresolved");
  assert.isTrue(returned[0]?.blocking);
  const laterUnknown = assessSeams(
    [snapshot(A), snapshot(B, []), snapshot(C), snapshot(D, [], C, false)],
    [],
  );
  assert.strictEqual(laterUnknown[0]?.status, "unknown");
  assert.isTrue(laterUnknown[0]?.blocking);
  assert.strictEqual(
    assessSeams([snapshot(A), snapshot(B), snapshot(C)], [])[0]?.id,
    seamIdentity(file()),
  );
});

it("separates repair, attested verification and comparable regression", () => {
  assert.deepStrictEqual(requireSeamRecords(records), records);
  assert.strictEqual(
    assessSeams([snapshot(A), snapshot(B, [])], [before, clear, repair])[0]?.status,
    "repair-unverified",
  );
  const verified = assessSeams([snapshot(A), snapshot(B, [])], records)[0];
  assert.strictEqual(verified?.status, "verified-repaired");
  assert.isFalse(verified?.blocking);
  const regressed = assessSeams([snapshot(A), snapshot(B, []), snapshot(C)], records)[0];
  assert.strictEqual(regressed?.status, "regressed");
  assert.isTrue(regressed?.blocking);
  assert.strictEqual(regressed?.repairSha, B);
  const newTarget = assessSeams(
    [snapshot(A), snapshot(B, []), snapshot(C, [file()], D)],
    records,
  )[0];
  assert.strictEqual(newTarget?.status, "returned-unresolved");
  assert.isTrue(newTarget?.blocking);
  const changedHead = assessSeams([snapshot(A), snapshot(C, [])], records)[0];
  assert.strictEqual(changedHead?.status, "unknown");
});

it("requires full comparable evidence and keeps an attested guard failure blocking", () => {
  const changed = seamRecord(freezeObservation(snapshot(B, [], D)));
  // Use the actual payload, without the previous record's digest.
  const { id: _id, ...proof } = verification;
  const incompatible = seamRecord({ ...proof, after: changed.id });
  assert.strictEqual(
    assessSeams([snapshot(A), snapshot(B, [], D)], [before, changed, repair, incompatible])[0]
      ?.status,
    "repair-unverified",
  );
  const partial = seamRecord(freezeObservation(snapshot(B, [], C, false)));
  const partialProof = seamRecord({ ...proof, after: partial.id });
  assert.strictEqual(
    assessSeams(
      [snapshot(A), snapshot(B, [], C, false)],
      [before, partial, repair, partialProof],
    )[0]?.status,
    "repair-unverified",
  );
  const failed = seamRecord({
    ...proof,
    guardProof: { ...proof.guardProof, exitCode: 1, output: "guard failed" },
  });
  const failedState = assessSeams([snapshot(A), snapshot(B, [])], [...records, failed])[0];
  assert.strictEqual(failedState?.status, "regressed");
  assert.isTrue(failedState?.blocking);
  const neverVerified = assessSeams(
    [snapshot(A), snapshot(B, [])],
    [before, clear, repair, failed],
  )[0];
  assert.strictEqual(neverVerified?.status, "repair-unverified");
  assert.isTrue(neverVerified?.blocking);
});

it("never suppresses an attested guard failure at a measurement boundary", () => {
  const { id: _id, ...proof } = verification;
  const changedBase = snapshot(B, []);
  assert.isDefined(changedBase.censusEvidence);
  const alternatives = [
    snapshot(B, [], D),
    { ...changedBase, censusEvidence: { ...changedBase.censusEvidence!, baseSha: C } },
    snapshot(B, [], C, false),
  ];
  for (const after of alternatives) {
    const frozen = seamRecord(freezeObservation(after));
    const failed = seamRecord({
      ...proof,
      after: frozen.id,
      guardProof: { ...proof.guardProof, exitCode: 1, output: "guard failed" },
    });
    const state = assessSeams([snapshot(A), after], [before, frozen, repair, failed])[0];
    assert.strictEqual(state?.status, "repair-unverified");
    assert.isTrue(state?.blocking);
    assert.include(state!.reason, "guard failed");
  }
  const legacy = seamRecord(freezeObservation({ tag: "legacy", fixedAt: null, files: [file()] }));
  const { id: _repairId, ...repairPayload } = repair;
  const legacyRepair = seamRecord({ ...repairPayload, before: { observation: legacy.id, row: 0 } });
  const failed = seamRecord({
    ...proof,
    repair: legacyRepair.id,
    guardProof: { ...proof.guardProof, exitCode: 1, output: "guard failed" },
  });
  const legacyState = assessSeams([snapshot(B, [])], [legacy, clear, legacyRepair, failed])[0];
  assert.strictEqual(legacyState?.status, "repair-unverified");
  assert.isTrue(legacyState?.blocking);
});

it("retains legacy identity without inventing absence or return across methods", () => {
  const legacy: CensusSnapshot = { tag: "legacy", fixedAt: null, files: [file()] };
  const absent = assessSeams([legacy, snapshot(B, [])], [])[0];
  assert.strictEqual(absent?.status, "unknown");
  const returned = assessSeams([legacy, snapshot(B, []), snapshot(C)], [])[0];
  assert.strictEqual(returned?.id, seamIdentity(file()));
  assert.strictEqual(returned?.status, "observed");
  assert.isFalse(returned?.blocking);
  const realReturn = assessSeams(
    [legacy, snapshot(B, []), snapshot(C), snapshot(D, []), snapshot(A)],
    [],
  )[0];
  assert.strictEqual(realReturn?.status, "returned-unresolved");
  assert.isTrue(realReturn?.blocking);
});

it("does not call the frozen pre-repair head a later regression", () => {
  const stale = assessSeams([snapshot(A)], records)[0];
  assert.strictEqual(stale?.status, "unknown");
  assert.isFalse(stale?.blocking);
  assert.include(stale!.reason, "pre-repair");
});

it("resolves transitive mappings independently of record order and refuses ambiguous roots", () => {
  const secondSnapshot = snapshot(B, [file("second.ts")]);
  const thirdSnapshot = snapshot(C, [file("third.ts")]);
  const second = seamRecord(freezeObservation(secondSnapshot));
  const third = seamRecord(freezeObservation(thirdSnapshot));
  const firstMapping = seamRecord({
    kind: "mapping",
    from: { observation: before.id, row: 0 },
    to: [{ observation: second.id, row: 0 }],
    attestation,
  } as const);
  const secondMapping = seamRecord({
    kind: "mapping",
    from: { observation: second.id, row: 0 },
    to: [{ observation: third.id, row: 0 }],
    attestation,
  } as const);
  for (const mappings of [
    [firstMapping, secondMapping],
    [secondMapping, firstMapping],
  ]) {
    const mapped = requireSeamRecords([before, second, third, ...mappings]);
    const states = assessSeams([snapshot(A), snapshot(B, []), thirdSnapshot], mapped);
    assert.strictEqual(states.length, 1);
    assert.strictEqual(states[0]?.id, seamIdentity(file()));
    assert.strictEqual(states[0]?.status, "returned-unresolved");
  }
  const ambiguous = seamRecord({
    kind: "mapping",
    from: { observation: third.id, row: 0 },
    to: [{ observation: second.id, row: 0 }],
    attestation,
  } as const);
  assert.throws(
    () => requireSeamRecords([before, second, third, firstMapping, ambiguous]),
    /ambiguous reviewed seam mapping/,
  );
  assert.throws(
    () => requireSeamRecords([before, second, third, secondMapping, ambiguous]),
    /cyclic reviewed seam mapping/,
  );
});

it("preserves rename, path move and split aliases with full frozen source rows", () => {
  const movedFiles = [file("new.ts", "feat: renamed patch"), file("split.ts", "feat: split patch")];
  const movedSnapshot = snapshot(B, movedFiles);
  const moved = seamRecord(freezeObservation(movedSnapshot));
  const mapping = seamRecord({
    kind: "mapping",
    from: { observation: before.id, row: 0 },
    to: movedFiles.map((_, row) => ({ observation: moved.id, row })),
    attestation,
  } as const);
  const mappedRecords = requireSeamRecords([before, moved, mapping]);
  const states = assessSeams([snapshot(A), snapshot(B, []), movedSnapshot], mappedRecords);
  assert.strictEqual(states.length, 1);
  assert.strictEqual(states[0]?.id, seamIdentity(file()));
  assert.strictEqual(states[0]?.status, "returned-unresolved");
  const ordinaryNextTag = assessSeams(
    [snapshot(A), movedSnapshot, snapshot(C, movedFiles, D)],
    mappedRecords,
  );
  assert.strictEqual(ordinaryNextTag.length, 1);
  const distinct = assessSeams(
    [snapshot(A), snapshot(B, [file("new.ts", "feat: unrelated new seam")])],
    [],
  );
  assert.strictEqual(distinct.length, 2);
  assert.isFalse(distinct.some((seam) => seam.blocking));
  assert.throws(() => requireSeamRecords([mapping]), /missing frozen observation/);
});

it("rejects altered digests, missing references and inconsistent retained evidence", () => {
  assert.throws(() => requireSeamRecords([{ ...repair, guard: "different" }]), /digest mismatch/);
  assert.throws(() => requireSeamRecords([repair]), /missing frozen observation/);
  assert.throws(
    () => requireSeamRecords([before, repair, verification]),
    /missing frozen observation/,
  );
  const wrong = seamRecord({ ...freezeObservation(snapshot(B)), files: [] });
  assert.throws(() => requireSeamRecords([wrong]), /rows or target/);
  const { id: _id, ...proof } = verification;
  const wrongHead = seamRecord({ ...proof, guardProof: { ...proof.guardProof, sourceSha: A } });
  assert.throws(() => requireSeamRecords([before, clear, repair, wrongHead]), /not bound/);
  const beyond = seamRecord({
    kind: "mapping",
    from: { observation: before.id, row: 0 },
    to: [{ observation: before.id, row: 99 }],
    attestation,
  } as const);
  assert.throws(() => requireSeamRecords([before, beyond]), /outside frozen observation/);
  const { id: _repairId, ...repairPayload } = repair;
  assert.throws(
    () => requireSeamRecords([before, seamRecord({ ...repairPayload, changeSha: "f".repeat(41) })]),
    /full seam evidence SHA/,
  );
});

const repository = (seed = true): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-seam-cli-"));
  runCommandText("git", ["init", "--quiet", root]);
  runCommandText("git", ["config", "user.name", "Fixture"], { cwd: root });
  runCommandText("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  if (seed) writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "fixture");
  return root;
};

it("records evidence idempotently and preserves it through walk and legacy readers", () => {
  const root = repository();
  try {
    const input = NodePath.join(root, "records.json");
    NodeFS.writeFileSync(input, JSON.stringify({ version: 1, records }));
    assert.strictEqual(run(["record", "--input", input], root), 0);
    const ref = runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root });
    assert.deepStrictEqual(readChurnState(root).seamRecords, records);
    assert.strictEqual(run(["record", "--input", input], root), 0);
    assert.strictEqual(runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }), ref);
    const walks = [walk("v1", snapshot(A))];
    writeChurnLedger(root, walks, "walk");
    assert.deepStrictEqual(readChurnState(root), { version: 2, walks, seamRecords: records });
    assert.deepStrictEqual(parseChurnState(JSON.stringify(walks)), {
      version: 2,
      walks,
      seamRecords: [],
    });
    const good = readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE);
    NodeFS.writeFileSync(
      input,
      JSON.stringify({ version: 1, records: [{ ...repair, guard: "corrupted" }] }),
    );
    assert.strictEqual(run(["record", "--input", input], root), 1);
    assert.strictEqual(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE), good);
    assert.strictEqual(run(["record", "--unknown"], root), 2);
    assert.strictEqual(run(["--help"], "/missing-repository"), 0);
    assert.strictEqual(run(["-h"], "/missing-repository"), 0);
    assert.strictEqual(run(["--unknown"], "/missing-repository"), 2);
    const docs = NodePath.join(root, "docs", "internals");
    NodeFS.mkdirSync(docs, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(docs, "fork-delta.md"),
      "## fork-meta\n\n### Retirement condition\n",
    );
    assert.strictEqual(run([], root), 0);
    assert.strictEqual(run(["--check"], root), 0);
    assert.strictEqual(run(["render", "--check"], root), 0);
    assert.strictEqual(readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE), good);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves records while seeding v2 and migrating legacy subjects", () => {
  const root = repository(false);
  try {
    const tree = runCommandText("git", ["mktree"], { cwd: root, input: "" }).trim();
    const commit = runCommandText("git", ["commit-tree", tree, "-m", "feat: legacy subject"], {
      cwd: root,
    }).trim();
    const legacy = {
      ...walk("legacy", snapshot(A)),
      censusFiles: [{ path: "legacy.ts", hunks: 1, commit, domain: "fork-meta" }],
    };
    const { censusEvidence: _evidence, ...legacyWalk } = legacy;
    const input = NodePath.join(root, "seed.json");
    NodeFS.writeFileSync(
      input,
      JSON.stringify({ version: 2, walks: [legacyWalk], seamRecords: records }),
    );
    assert.strictEqual(run(["seed", "--from", input], root), 0);
    assert.deepStrictEqual(readChurnState(root).seamRecords, records);
    // Force a genuinely subjectless legacy row to exercise the later migration writer.
    writeChurnState(
      root,
      { version: 2, walks: [legacyWalk], seamRecords: records },
      "legacy subjects",
    );
    assert.strictEqual(run(["migrate-subjects"], root), 0);
    assert.deepStrictEqual(readChurnState(root).seamRecords, records);
    assert.strictEqual(
      readChurnState(root).walks[0]?.censusFiles[0]?.subject,
      "feat: legacy subject",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("publishes record bundles with a lease and restores the local ref after a stale-lease refusal", () => {
  const root = repository();
  try {
    const remote = NodePath.join(root, "remote.git");
    runCommandText("git", ["init", "--quiet", "--bare", remote], { cwd: root });
    runCommandText("git", ["remote", "add", "origin", remote], { cwd: root });
    runCommandText("git", ["push", "--quiet", "origin", `${CHURN_REF}:${CHURN_REF}`], {
      cwd: root,
    });
    const input = NodePath.join(root, "records.json");
    NodeFS.writeFileSync(input, JSON.stringify({ version: 1, records }));
    assert.strictEqual(run(["record", "--input", input, "--push"], root), 0);
    const expectedOld = runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim();
    assert.strictEqual(
      runCommandText("git", ["ls-remote", "origin", CHURN_REF], { cwd: root }).split("\t")[0],
      expectedOld,
    );
    const tree = runCommandText("git", ["rev-parse", `${CHURN_REF}^{tree}`], { cwd: root }).trim();
    const rival = runCommandText("git", ["commit-tree", tree, "-p", expectedOld, "-m", "rival"], {
      cwd: root,
    }).trim();
    runCommandText("git", ["push", "--quiet", "origin", `${rival}:${CHURN_REF}`], { cwd: root });
    const fresh = seamRecord(freezeObservation(snapshot(D, [file("new.ts")])));
    NodeFS.writeFileSync(input, JSON.stringify({ version: 1, records: [fresh] }));
    assert.strictEqual(run(["record", "--input", input, "--push"], root), 1);
    assert.strictEqual(
      runCommandText("git", ["rev-parse", CHURN_REF], { cwd: root }).trim(),
      expectedOld,
    );
    assert.strictEqual(
      runCommandText("git", ["ls-remote", "origin", CHURN_REF], { cwd: root }).split("\t")[0],
      rival,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("exercises report comments and failure exits for absence, return and verified regression", () => {
  const root = repository();
  const oldPath = process.env.PATH;
  const oldBody = process.env.SEAM_FIXTURE_BODY;
  const oldOutput = process.env.SEAM_FIXTURE_OUTPUT;
  try {
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('view')) process.stdout.write(JSON.stringify({body: process.env.SEAM_FIXTURE_BODY, comments: []}));
else { const i=process.argv.indexOf('--body-file'); fs.copyFileSync(process.argv[i+1],process.env.SEAM_FIXTURE_OUTPUT); process.stdout.write('https://example.test/comment'); }
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    process.env.SEAM_FIXTURE_OUTPUT = NodePath.join(root, "posted.md");
    const changedTarget = snapshot(B, [], D);
    const changed = seamRecord(freezeObservation(changedTarget));
    const { id: _id, ...proof } = verification;
    const failed = seamRecord({
      ...proof,
      after: changed.id,
      guardProof: { ...proof.guardProof, exitCode: 1, output: "guard failed" },
    });
    const legacy: CensusSnapshot = { tag: "legacy", fixedAt: null, files: [file()] };
    const cases: ReadonlyArray<{
      snapshots: ReadonlyArray<CensusSnapshot>;
      current: CensusSnapshot;
      records: ReadonlyArray<SeamRecord>;
      status: string;
      exit: number;
    }> = [
      {
        snapshots: [snapshot(A)],
        current: snapshot(B, []),
        records: [],
        status: "not-observed",
        exit: 0,
      },
      {
        snapshots: [snapshot(A), snapshot(B, [])],
        current: snapshot(C),
        records: [],
        status: "returned-unresolved",
        exit: 1,
      },
      {
        snapshots: [snapshot(A)],
        current: snapshot(B, []),
        records,
        status: "verified-repaired",
        exit: 0,
      },
      {
        snapshots: [snapshot(A), snapshot(B, [])],
        current: snapshot(C),
        records,
        status: "regressed",
        exit: 1,
      },
      {
        snapshots: [snapshot(A)],
        current: changedTarget,
        records: [before, changed, repair, failed],
        status: "repair-unverified",
        exit: 1,
      },
      {
        snapshots: [legacy],
        current: snapshot(B, []),
        records: [],
        status: "unknown",
        exit: 0,
      },
      {
        snapshots: [legacy, snapshot(B, [])],
        current: snapshot(C),
        records: [],
        status: "| observed |",
        exit: 0,
      },
      {
        snapshots: [snapshot(A)],
        current: snapshot(A),
        records,
        status: "pre-repair",
        exit: 0,
      },
    ];
    for (const item of cases) {
      writeChurnState(
        root,
        {
          version: 2,
          walks: item.snapshots.map((snapshot, i) =>
            walk(i === item.snapshots.length - 1 ? item.current.tag : `old-${i}`, snapshot),
          ),
          seamRecords: item.records,
        },
        "case",
      );
      process.env.SEAM_FIXTURE_BODY = `## Sequential rebase census\n<!-- sequential-census-v1:${JSON.stringify(item.current.censusEvidence)} -->`;
      assert.strictEqual(run(["report", "--issue", "1"], root), item.exit);
      const posted = NodeFS.readFileSync(process.env.SEAM_FIXTURE_OUTPUT, "utf8");
      assert.include(posted, item.status);
      if (item.records.length === 0) assert.notInclude(posted, "was fixed at");
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldBody === undefined) delete process.env.SEAM_FIXTURE_BODY;
    else process.env.SEAM_FIXTURE_BODY = oldBody;
    if (oldOutput === undefined) delete process.env.SEAM_FIXTURE_OUTPUT;
    else process.env.SEAM_FIXTURE_OUTPUT = oldOutput;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
