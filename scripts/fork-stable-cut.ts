#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - hyprws-stable.yml runs this before any install.

// Automatic: the newest upstream stable without a fork stable, cut from the fork nightly on
// exactly its commit. `--recut`: the trunk tip, under the newest upstream stable it contains.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import {
  parseNightlyForkTag,
  parseStableForkTag,
  parseUpstreamReleaseTag,
  resolveNextForkStableTag,
  type VersionParts,
} from "./lib/fork-policy.ts";

/** The mirror job keeps `main` identical to upstream's. */
const UPSTREAM_MAIN = "origin/main";

export interface TaggedCommit {
  readonly tag: string;
  readonly sha: string;
}

export interface StableCutInput {
  readonly tags: ReadonlyArray<string>;
  readonly upstreamStables: ReadonlyArray<TaggedCommit>;
  /** Fork nightlies, each with the upstream commit its stack sits on. */
  readonly nightlies: ReadonlyArray<TaggedCommit & { readonly baseSha: string }>;
  /** Set for a manual recut: the trunk tip and the upstream stable tags it contains. */
  readonly recut: { readonly sha: string; readonly contained: ReadonlyArray<string> } | null;
}

export type StableCut =
  | { readonly cut: true; readonly tag: string; readonly sha: string; readonly reason: string }
  | { readonly cut: false; readonly reason: string };

const byVersion = (left: VersionParts, right: VersionParts): number =>
  left.major - right.major || left.minor - right.minor || left.patch - right.patch;

const isForkStableOf = (tag: string, version: VersionParts): boolean => {
  const parsed = parseStableForkTag(tag);
  return parsed !== null && byVersion(parsed, version) === 0;
};

const newestStable = (tags: ReadonlyArray<string>): string | null =>
  tags
    .map(parseUpstreamReleaseTag)
    .filter((parsed) => parsed?.channel === "stable")
    .toSorted((left, right) => byVersion(right!, left!))[0]?.tag ?? null;

export const decideStableCut = (input: StableCutInput): StableCut => {
  if (input.recut !== null) {
    const upstream = newestStable(input.recut.contained);
    const tag = upstream === null ? null : resolveNextForkStableTag(upstream, input.tags);
    return tag === null
      ? { cut: false, reason: "the trunk contains no upstream stable tag" }
      : { cut: true, tag, sha: input.recut.sha, reason: `recut of the trunk tip as ${tag}` };
  }
  const upstream = newestStable(input.upstreamStables.map(({ tag }) => tag));
  const target = input.upstreamStables.find(({ tag }) => tag === upstream);
  if (upstream === null || target === undefined)
    return { cut: false, reason: "no upstream stable tag" };
  const version = parseUpstreamReleaseTag(upstream)!;
  if (input.tags.some((tag) => isForkStableOf(tag, version)))
    return { cut: false, reason: `${upstream} already has a fork stable` };
  const nightly = input.nightlies
    .filter(({ baseSha }) => baseSha === target.sha)
    .map((entry) => ({ entry, parsed: parseNightlyForkTag(entry.tag) }))
    .filter(({ parsed }) => parsed !== null)
    .toSorted(
      (left, right) =>
        right.parsed!.date.localeCompare(left.parsed!.date) ||
        right.parsed!.runNumber - left.parsed!.runNumber,
    )[0]?.entry;
  if (nightly === undefined)
    return { cut: false, reason: `no fork nightly sits on ${upstream}; a recut covers it` };
  const tag = resolveNextForkStableTag(upstream, input.tags)!;
  return { cut: true, tag, sha: nightly.sha, reason: `${tag} from ${nightly.tag}` };
};

const git = (args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();

const lines = (value: string): ReadonlyArray<string> => value.split("\n").filter(Boolean);

const readInput = (recut: boolean): StableCutInput => {
  const refs = lines(
    git([
      "for-each-ref",
      "--format=%(refname:strip=2)\t%(objectname)\t%(*objectname)",
      "refs/tags/v*",
    ]),
  ).map((record) => {
    const [tag = "", objectSha = "", peeledSha = ""] = record.split("\t");
    return { tag, sha: peeledSha || objectSha };
  });
  const tags = refs.map(({ tag }) => tag);
  return {
    tags,
    upstreamStables: refs.filter(({ tag }) => parseUpstreamReleaseTag(tag)?.channel === "stable"),
    nightlies: recut
      ? []
      : refs
          .filter(({ tag }) => parseNightlyForkTag(tag) !== null)
          .map((ref) => ({ ...ref, baseSha: git(["merge-base", ref.sha, UPSTREAM_MAIN]) })),
    recut: recut
      ? {
          sha: git(["rev-parse", "HEAD"]),
          contained: lines(git(["tag", "--merged", "HEAD", "--list", "v*"])),
        }
      : null,
  };
};

if (import.meta.main) {
  try {
    const { values } = NodeUtil.parseArgs({
      options: { recut: { type: "boolean" }, "github-output": { type: "boolean" } },
    });
    const decision = decideStableCut(readInput(values.recut === true));
    process.stdout.write(`${decision.cut ? "cut" : "skip"}: ${decision.reason}\n`);
    if (decision.cut && values["github-output"]) {
      const output = process.env.GITHUB_OUTPUT;
      if (output === undefined) throw new Error("GITHUB_OUTPUT is not set");
      NodeFS.appendFileSync(output, `tag=${decision.tag}\nsha=${decision.sha}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
