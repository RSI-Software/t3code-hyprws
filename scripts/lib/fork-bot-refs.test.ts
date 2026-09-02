// @effect-diagnostics nodeBuiltinImport:off - Bot-owned refs are Git plumbing; fixtures need real repositories.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  CHURN_LEDGER_FILE,
  CHURN_REF,
  readBotRefFile,
  resolveBotRef,
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
