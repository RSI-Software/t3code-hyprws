import { assert, it } from "@effect/vitest";

import {
  checkLockfile,
  renderReport,
  run,
  type CommandResult,
  type LockfileEnv,
} from "./fork-lockfile.ts";

const IMPORTERS = ["importers:", "  apps/web:", "    dependencies:", "      react: 19.2.6"].join(
  "\n",
);
const LOCKFILE = `lockfileVersion: '9.0'\n\n${IMPORTERS}\n\nsnapshots:\n  react@19.2.6: {}\n`;

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });

interface Harness {
  readonly env: LockfileEnv;
  readonly contents: () => string;
  readonly generated: () => number;
}

/** A lockfile the generator rewrites to `regenerated`, as the real one does in place. */
const harness = (options: {
  readonly committed?: string;
  readonly regenerated?: string;
  readonly status?: CommandResult;
  readonly generator?: CommandResult;
  /** Stands in for a generator that throws instead of exiting non-zero. */
  readonly throws?: Error;
  readonly onInterrupt?: LockfileEnv["onInterrupt"];
}): Harness => {
  let contents = options.committed ?? LOCKFILE;
  let generated = 0;
  return {
    contents: () => contents,
    generated: () => generated,
    env: {
      // Spread, not assigned: `exactOptionalPropertyTypes` rejects an explicit
      // `undefined`, and omitting it is what covers the no-guard path.
      ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
      git: () => options.status ?? ok(),
      generate: () => {
        generated += 1;
        contents = options.regenerated ?? contents;
        if (options.throws) throw options.throws;
        return options.generator ?? ok();
      },
      readLockfile: () => contents,
      writeLockfile: (next) => {
        contents = next;
      },
    },
  };
};

it("passes when the committed lockfile regenerates unchanged", () => {
  const subject = harness({});
  const report = checkLockfile(subject.env);
  assert.strictEqual(report.status, "ok");
  assert.strictEqual(report.drift, "none");
  assert.strictEqual(report.remedy, null);
  assert.strictEqual(report.note, null);
  assert.strictEqual(subject.generated(), 1);
});

it("passes a fresh resolution that only moves transitive versions, with a note", () => {
  // The generator re-resolves every open range, so a branch that changed nothing
  // still sees unrelated pins move. Failing on that would import someone else's churn.
  const subject = harness({
    regenerated: LOCKFILE.replace("react@19.2.6: {}", "react@19.2.7: {}"),
  });
  const report = checkLockfile(subject.env);
  assert.strictEqual(report.status, "resolutions-differ");
  assert.strictEqual(report.drift, "snapshots");
  assert.strictEqual(report.remedy, null);
  assert.include(report.note ?? "", "re-resolves every open range");
});

it("fails importer drift, where a declared specifier never reached the lockfile", () => {
  const subject = harness({ regenerated: LOCKFILE.replace("react: 19.2.6", "react: 19.2.7") });
  const report = checkLockfile(subject.env);
  assert.strictEqual(report.status, "drift");
  assert.strictEqual(report.drift, "importers");
  assert.include(report.remedy ?? "", "owns the manifest");
});

it("restores the committed bytes after drift, so the check never edits the tree", () => {
  const subject = harness({ regenerated: LOCKFILE.replace("react: 19.2.6", "react: 19.2.7") });
  assert.strictEqual(checkLockfile(subject.env).status, "drift");
  assert.strictEqual(subject.contents(), LOCKFILE);
});

it("restores the committed bytes when the generator throws", () => {
  const subject = harness({
    regenerated: `${LOCKFILE}partial: true\n`,
    throws: new Error("spawn ENOMEM"),
  });
  assert.throws(() => checkLockfile(subject.env), /spawn ENOMEM/);
  assert.strictEqual(subject.contents(), LOCKFILE);
});

it("registers an interrupt restore for the regeneration and unregisters it after", () => {
  let restore: (() => void) | null = null;
  let disposed = false;
  const subject = harness({
    regenerated: `${LOCKFILE}partial: true\n`,
    throws: new Error("interrupted"),
    onInterrupt: (register) => {
      restore = register;
      return () => {
        disposed = true;
      };
    },
  });
  assert.throws(() => checkLockfile(subject.env));
  assert.isFunction(restore);
  assert.isTrue(disposed);
});

it("restores the committed bytes after a failing generator", () => {
  const subject = harness({
    regenerated: `${LOCKFILE}partial: true\n`,
    generator: failed("ERR_PNPM_NO_MATCHING_VERSION"),
  });
  const report = checkLockfile(subject.env);
  assert.strictEqual(report.status, "generator-failed");
  assert.include(report.detail, "ERR_PNPM_NO_MATCHING_VERSION");
  assert.strictEqual(subject.contents(), LOCKFILE);
});

it("refuses an uncommitted lockfile instead of overwriting it", () => {
  const subject = harness({ status: ok(" M pnpm-lock.yaml\n") });
  const report = checkLockfile(subject.env);
  assert.strictEqual(report.status, "uncommitted");
  assert.strictEqual(subject.generated(), 0);
  assert.strictEqual(subject.contents(), LOCKFILE);
});

it("renders a remedy only for a finding, and a note for a qualified pass", () => {
  assert.strictEqual(
    renderReport(checkLockfile(harness({}).env)),
    "ok: pnpm-lock.yaml regenerates unchanged\n",
  );
  const noted = renderReport(
    checkLockfile(harness({ regenerated: `${LOCKFILE}  react@19.2.7: {}\n` }).env),
  );
  assert.match(noted, /^ok: pnpm-lock\.yaml matches its manifests;.*\n {2}the generator/);
  const drifted = renderReport(
    checkLockfile(harness({ regenerated: LOCKFILE.replace("react: 19.2.6", "react: 19.2.7") }).env),
  );
  assert.match(
    drifted,
    /^failed: pnpm-lock\.yaml does not record the specifiers its manifests declare\n {2}/,
  );
});

it("exits 2 on an unknown option and 0 on help", () => {
  const errors: Array<string> = [];
  const outputs: Array<string> = [];
  const output = {
    stdout: (message: string) => outputs.push(message),
    stderr: (message: string) => errors.push(message),
  };
  assert.strictEqual(run(["--fix"], process.cwd(), output), 2);
  assert.match(errors.join(""), /unknown option: --fix/);
  assert.strictEqual(run(["--help"], process.cwd(), output), 0);
  assert.match(outputs.join(""), /vp run fork:lockfile/);
});
