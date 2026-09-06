import { assert, it } from "@effect/vitest";

import {
  resolveStackRangeHash,
  stackRangeHash,
  type CommandResult,
  type CommandRunner,
} from "./fork-release-delta-rev.ts";

const firstPatchId = "1".repeat(40);
const secondPatchId = "2".repeat(40);

it("hashes newline-terminated stable patch IDs in stack order", () => {
  assert.equal(
    stackRangeHash([firstPatchId, secondPatchId]),
    "sha256:5aa79872074472c4e083eda6da6837b89afe1575efd540c548c6cc5130ebbfbb",
  );
  assert.notEqual(
    stackRangeHash([firstPatchId, secondPatchId]),
    stackRangeHash([secondPatchId, firstPatchId]),
  );
});

it("computes the release range from the merge base and stable patch IDs", () => {
  const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const responses: Array<CommandResult> = [
    { status: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" },
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: `${"b".repeat(40)}\n${"c".repeat(40)}\n`, stderr: "" },
    { status: 0, stdout: "first patch", stderr: "" },
    { status: 0, stdout: `${firstPatchId} 0000000\n`, stderr: "" },
    { status: 0, stdout: "second patch", stderr: "" },
    { status: 0, stdout: `${secondPatchId} 0000000\n`, stderr: "" },
  ];
  const runner: CommandRunner = {
    run(command, args) {
      calls.push({ command, args });
      return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
    },
  };

  assert.equal(
    resolveStackRangeHash(runner, "main", "hyprws"),
    "sha256:5aa79872074472c4e083eda6da6837b89afe1575efd540c548c6cc5130ebbfbb",
  );
  assert.deepStrictEqual(calls.slice(0, 3), [
    { command: "git", args: ["merge-base", "main", "hyprws"] },
    { command: "git", args: ["rev-list", "--merges", `${"a".repeat(40)}..hyprws`] },
    {
      command: "git",
      args: ["rev-list", "--reverse", "--no-merges", `${"a".repeat(40)}..hyprws`],
    },
  ]);
});
