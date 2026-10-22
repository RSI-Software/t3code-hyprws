// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need synchronous Git reads.

import * as NodeChildProcess from "node:child_process";

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  runCommand,
  runCommandText,
  type CommandResult,
} from "./fork-command.ts";

export interface GitReader {
  readonly run: (args: ReadonlyArray<string>) => string;
  readonly readBlobs: (specs: Iterable<string>) => ReadonlyMap<string, string>;
}

/**
 * Each `<rev>:<path>` spec's blob text, read by two `git cat-file` processes however many specs
 * there are; a spec that names no blob has no entry. One `git show` per path cost a scan 16k
 * process spawns, about 65 ms each on CI. Identical blobs across trees are read once.
 */
export const readBlobs = (cwd: string, specs: Iterable<string>): ReadonlyMap<string, string> => {
  const unique = [...new Set(specs)];
  const blobs = new Map<string, string>();
  if (unique.length === 0) return blobs;
  // NUL framing: a path may itself hold a newline.
  const check = runCommandText(
    "git",
    ["cat-file", "-Z", "--batch-check=%(objectname) %(objecttype)"],
    { cwd, input: `${unique.join("\0")}\0` },
  ).split("\0");
  const shaBySpec = new Map<string, string>();
  unique.forEach((spec, index) => {
    const [sha, type] = (check[index] ?? "").split(" ");
    if (type === "blob" && sha !== undefined && /^[0-9a-f]+$/.test(sha)) shaBySpec.set(spec, sha);
  });
  const shas = [...new Set(shaBySpec.values())];
  if (shas.length === 0) return blobs;
  const result = NodeChildProcess.spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    input: `${shas.join("\n")}\n`,
    maxBuffer: 1 << 30,
    timeout: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git cat-file --batch failed: ${result.stderr}`);
  // `<sha> blob <size>\n<bytes>\n` per object; size counts bytes, so parse the raw buffer.
  const out = result.stdout;
  const textBySha = new Map<string, string>();
  for (let offset = 0; offset < out.length;) {
    const headerEnd = out.indexOf(10, offset);
    const [sha = "", , size = "0"] = out.toString("utf8", offset, headerEnd).split(" ");
    const start = headerEnd + 1;
    const end = start + Number(size);
    textBySha.set(sha, out.toString("utf8", start, end));
    offset = end + 1;
  }
  for (const [spec, sha] of shaBySpec) {
    const text = textBySha.get(sha);
    if (text !== undefined) blobs.set(spec, text);
  }
  return blobs;
};

export class SystemGit {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  run(args: ReadonlyArray<string>): string {
    return runCommandText("git", args, { cwd: this.cwd });
  }

  readBlobs(specs: Iterable<string>): ReadonlyMap<string, string> {
    return readBlobs(this.cwd, specs);
  }

  runResult(args: ReadonlyArray<string>, timeout?: number): CommandResult {
    return runCommand("git", args, {
      cwd: this.cwd,
      ...(timeout === undefined ? {} : { timeout }),
    });
  }
}
