#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  parseNightlyForkTag,
  parseStableForkTag,
  parseUpstreamReleaseTag,
} from "./lib/fork-policy.ts";
import { readDesktopBaseVersion } from "./resolve-nightly-release.ts";
import { listGitTags } from "./resolve-previous-release-tag.ts";

const ForkReleaseChannel = Schema.Literals(["stable", "nightly"]);
export type ForkReleaseChannel = typeof ForkReleaseChannel.Type;

export interface ForkReleaseMetadata {
  readonly version: string;
  readonly tag: string;
  readonly name: string;
  readonly shortSha: string;
  readonly isPrerelease: boolean;
  readonly makeLatest: boolean;
}

export class InvalidForkReleaseInputError extends Schema.TaggedErrorClass<InvalidForkReleaseInputError>()(
  "InvalidForkReleaseInputError",
  {
    channel: ForkReleaseChannel,
    reason: Schema.Literals(["tag", "upstream-version", "date", "run-number", "sha"]),
  },
) {
  override get message(): string {
    if (this.channel === "stable" && this.reason === "tag") {
      return "Stable fork releases require a vX.Y.Z-hyprws.N tag ref.";
    }
    if (this.channel === "stable" && this.reason === "upstream-version") {
      return "Stable fork release derivation requires an X.Y.Z upstream version.";
    }
    return `Invalid ${this.channel} fork release ${this.reason}.`;
  }
}

export class ForkReleaseGitHubOutputConfigError extends Schema.TaggedErrorClass<ForkReleaseGitHubOutputConfigError>()(
  "ForkReleaseGitHubOutputConfigError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to resolve GITHUB_OUTPUT for fork release metadata.";
  }
}

export class ForkReleaseGitHubOutputAppendError extends Schema.TaggedErrorClass<ForkReleaseGitHubOutputAppendError>()(
  "ForkReleaseGitHubOutputAppendError",
  {
    outputPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append fork release metadata to ${this.outputPath}.`;
  }
}

const compareNumberFields = <T extends object>(
  left: T,
  right: T,
  fields: ReadonlyArray<keyof T>,
): number => {
  for (const field of fields) {
    const comparison = Number(left[field]) - Number(right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
};

export const resolveNextForkStableTag = (
  upstreamVersion: string,
  tags: ReadonlyArray<string>,
): string | null => {
  const upstream = parseUpstreamReleaseTag(`v${upstreamVersion}`);
  if (upstream === null || upstream.channel !== "stable") return null;
  const revision = tags.reduce((highest, tag) => {
    const parsed = parseStableForkTag(tag);
    return parsed !== null &&
      parsed.major === upstream.major &&
      parsed.minor === upstream.minor &&
      parsed.patch === upstream.patch
      ? Math.max(highest, parsed.revision)
      : highest;
  }, 0);
  return `v${upstreamVersion}-hyprws.${revision + 1}`;
};

export const resolvePreviousForkReleaseTag = (
  channel: ForkReleaseChannel,
  currentTag: string,
  tags: ReadonlyArray<string>,
): string | undefined => {
  if (channel === "stable") {
    const current = parseStableForkTag(currentTag);
    if (current === null) return undefined;
    return tags
      .map((tag) => ({ tag, parsed: parseStableForkTag(tag) }))
      .filter(
        (entry): entry is { tag: string; parsed: NonNullable<typeof entry.parsed> } =>
          entry.parsed !== null,
      )
      .filter(
        ({ parsed }) =>
          compareNumberFields(parsed, current, ["major", "minor", "patch", "revision"]) < 0,
      )
      .toSorted((left, right) =>
        compareNumberFields(right.parsed, left.parsed, ["major", "minor", "patch", "revision"]),
      )[0]?.tag;
  }

  const current = parseNightlyForkTag(currentTag);
  if (current === null) return undefined;
  return tags
    .map((tag) => ({ tag, parsed: parseNightlyForkTag(tag) }))
    .filter(
      (entry): entry is { tag: string; parsed: NonNullable<typeof entry.parsed> } =>
        entry.parsed !== null,
    )
    .filter(
      ({ parsed }) =>
        compareNumberFields(parsed, current, ["major", "minor", "patch", "date", "runNumber"]) < 0,
    )
    .toSorted((left, right) =>
      compareNumberFields(right.parsed, left.parsed, [
        "major",
        "minor",
        "patch",
        "date",
        "runNumber",
      ]),
    )[0]?.tag;
};

export const resolveForkNightlyReleaseMetadata = (
  baseVersion: string,
  date: string,
  runNumber: number,
  sha: string,
): ForkReleaseMetadata => {
  const shortSha = sha.slice(0, 12);
  const version = `${baseVersion}-hyprws-nightly.${date}.${runNumber}`;
  return {
    version,
    tag: `v${version}`,
    name: `T3 Code hyprws Nightly ${version} (${shortSha})`,
    shortSha,
    isPrerelease: true,
    makeLatest: false,
  };
};

export const resolveForkStableReleaseMetadata = (tag: string) => {
  const parsed = parseStableForkTag(tag);
  if (parsed === null) {
    return Effect.fail(new InvalidForkReleaseInputError({ channel: "stable", reason: "tag" }));
  }
  const version = tag.slice(1);
  return Effect.succeed({
    version,
    tag,
    name: `T3 Code hyprws v${version}`,
    shortSha: "",
    isPrerelease: false,
    makeLatest: true,
  } satisfies ForkReleaseMetadata);
};

export const writeForkReleaseOutput = Effect.fn("writeForkReleaseOutput")(function* (
  metadata: ForkReleaseMetadata,
  previousTag: string | undefined,
  writeGithubOutput: boolean,
) {
  const entries = [
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["name", metadata.name],
    ["short_sha", metadata.shortSha],
    ["previous_tag", previousTag ?? ""],
    ["is_prerelease", String(metadata.isPrerelease)],
    ["make_latest", String(metadata.makeLatest)],
  ] as const;
  const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join("");

  if (writeGithubOutput) {
    const fs = yield* FileSystem.FileSystem;
    const outputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT").pipe(
      Effect.mapError((cause) => new ForkReleaseGitHubOutputConfigError({ cause })),
    );
    yield* fs
      .writeFileString(outputPath, serialized, { flag: "a" })
      .pipe(
        Effect.mapError((cause) => new ForkReleaseGitHubOutputAppendError({ outputPath, cause })),
      );
    return;
  }

  yield* Console.log(serialized.trimEnd());
});

const requireNightlyInput = <A>(value: A | undefined, reason: "date" | "run-number" | "sha") =>
  value === undefined
    ? Effect.fail(new InvalidForkReleaseInputError({ channel: "nightly", reason }))
    : Effect.succeed(value);

export const forkReleaseVersionCommand = Command.make(
  "fork-release-version",
  {
    channel: Flag.choice("channel", ForkReleaseChannel.literals).pipe(
      Flag.withDescription("Fork release channel."),
    ),
    tag: Flag.string("tag").pipe(Flag.withDescription("Stable fork release tag."), Flag.optional),
    upstreamVersion: Flag.string("upstream-version").pipe(
      Flag.withDescription("Derive the next stable tag for this upstream X.Y.Z version."),
      Flag.optional,
    ),
    date: Flag.string("date").pipe(
      Flag.withDescription("Nightly build date in YYYYMMDD."),
      Flag.optional,
    ),
    runNumber: Flag.integer("run-number").pipe(
      Flag.withDescription("GitHub Actions run number for a nightly."),
      Flag.optional,
    ),
    sha: Flag.string("sha").pipe(
      Flag.withDescription("Commit sha for the nightly build."),
      Flag.optional,
    ),
    root: Flag.string("root").pipe(
      Flag.withDescription("Workspace root used to read desktop package metadata."),
      Flag.optional,
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ channel, tag, upstreamVersion, date, runNumber, sha, root, githubOutput }) =>
    Effect.gen(function* () {
      const tags = yield* listGitTags();
      const metadata =
        channel === "stable"
          ? resolveForkStableReleaseMetadata(
              Option.getOrElse(tag, () => {
                const version = Option.getOrElse(upstreamVersion, () => "");
                return resolveNextForkStableTag(version, tags) ?? "";
              }),
            )
          : Effect.gen(function* () {
              const nightlyDate = yield* requireNightlyInput(Option.getOrUndefined(date), "date");
              if (parseUpstreamReleaseTag(`v0.0.0-nightly.${nightlyDate}.1`) === null) {
                return yield* new InvalidForkReleaseInputError({
                  channel: "nightly",
                  reason: "date",
                });
              }
              const nightlyRunNumber = yield* requireNightlyInput(
                Option.getOrUndefined(runNumber),
                "run-number",
              );
              if (!Number.isInteger(nightlyRunNumber) || nightlyRunNumber < 1) {
                return yield* new InvalidForkReleaseInputError({
                  channel: "nightly",
                  reason: "run-number",
                });
              }
              const nightlySha = yield* requireNightlyInput(Option.getOrUndefined(sha), "sha");
              if (!/^[0-9a-f]{7,40}$/i.test(nightlySha)) {
                return yield* new InvalidForkReleaseInputError({
                  channel: "nightly",
                  reason: "sha",
                });
              }
              const baseVersion = yield* readDesktopBaseVersion(Option.getOrUndefined(root));
              return resolveForkNightlyReleaseMetadata(
                baseVersion,
                nightlyDate,
                nightlyRunNumber,
                nightlySha,
              );
            });

      if (
        channel === "stable" &&
        Option.isNone(tag) &&
        resolveNextForkStableTag(
          Option.getOrElse(upstreamVersion, () => ""),
          tags,
        ) === null
      ) {
        return yield* new InvalidForkReleaseInputError({
          channel: "stable",
          reason: "upstream-version",
        });
      }
      const resolvedMetadata = yield* metadata;
      const previousTag = resolvePreviousForkReleaseTag(channel, resolvedMetadata.tag, tags);
      yield* writeForkReleaseOutput(resolvedMetadata, previousTag, githubOutput);
    }),
).pipe(Command.withDescription("Resolve stable or nightly fork release metadata."));

if (import.meta.main) {
  Command.run(forkReleaseVersionCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
