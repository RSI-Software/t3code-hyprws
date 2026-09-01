// @effect-diagnostics nodeBuiltinImport:off - Temporary ledger fixtures use Node helpers.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { parseArgs, UsageError } from "./fork-cli.ts";
import { commandText } from "./fork-command.ts";
import { readForkRetirementLedger } from "./fork-retirement-ledger.ts";
import {
  FORK_LOG_FIELD_SEPARATOR as FS,
  FORK_LOG_RECORD_SEPARATOR as RS,
  parseForkLog,
  parseForkTrailers,
} from "./fork-trailers.ts";

it("parses shared value, flag, and positional CLI arguments", () => {
  const parsed = parseArgs(["verb", "--tag", "v1.2.3", "--dry-run"], {
    values: ["--tag"],
    flags: ["--dry-run"],
    positionals: 1,
  });
  assert.equal(parsed.values.get("--tag"), "v1.2.3");
  assert.isTrue(parsed.flags.has("--dry-run"));
  assert.deepStrictEqual(parsed.positionals, ["verb"]);
  assert.throws(() => parseArgs(["--tag"], { values: ["--tag"] }), UsageError);
});

it("renders command diagnostics with shell-unsafe values quoted", () => {
  assert.equal(commandText("vp", ["run", "hello world"]), 'vp run "hello world"');
});

it("parses trailers from the full body above a co-author paragraph", () => {
  const body =
    "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no\n\nCo-authored-by: A <a@example.com>\n";
  assert.deepStrictEqual(parseForkTrailers(body), {
    domain: "fork-meta",
    tier: "bugfix",
    upstreamable: "no",
  });
  const raw = `abc${FS}abc${FS}fix: example${FS}${body}${RS}`;
  assert.equal(parseForkLog(raw)[0]?.domain, "fork-meta");
});

it("requires the canonical retirement ledger file", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ledger-required-"));
  try {
    assert.throws(() => readForkRetirementLedger(root), /ENOENT/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
