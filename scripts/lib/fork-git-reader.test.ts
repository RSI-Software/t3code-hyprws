// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { runCommand } from "./fork-command.ts";
import { readBlobs } from "./fork-git-reader.ts";

it("reads each blob by its own spec when a path holds a newline", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-command-blobs-"));
  NodeFS.writeFileSync(NodePath.join(dir, "a"), "first");
  NodeFS.writeFileSync(NodePath.join(dir, "a\nb"), "second");
  NodeFS.writeFileSync(NodePath.join(dir, "b"), "third");
  const git = (...args: ReadonlyArray<string>) => runCommand("git", args, { cwd: dir });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "blobs");
  const blobs = readBlobs(dir, ["HEAD:a", "HEAD:a\nb", "HEAD:b", "HEAD:missing"]);
  assert.deepStrictEqual(Object.fromEntries(blobs), {
    "HEAD:a": "first",
    "HEAD:a\nb": "second",
    "HEAD:b": "third",
  });
});
