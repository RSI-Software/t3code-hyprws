import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  resolveForkNightlyReleaseMetadata,
  resolveForkStableReleaseMetadata,
  resolveNextForkStableTag,
  resolvePreviousForkReleaseTag,
  writeForkReleaseOutput,
} from "./fork-release-version.ts";

it("derives fork nightly metadata with the run and short commit sha", () => {
  assert.deepStrictEqual(
    resolveForkNightlyReleaseMetadata("1.2.4", "20260829", 17, "abcdef1234567890"),
    {
      version: "1.2.4-hyprws-nightly.20260829.17",
      tag: "v1.2.4-hyprws-nightly.20260829.17",
      name: "T3 Code hyprws Nightly 1.2.4-hyprws-nightly.20260829.17 (abcdef123456)",
      shortSha: "abcdef123456",
      isPrerelease: true,
      makeLatest: false,
    },
  );
});

it.effect("parses stable fork tags without changing the existing release shape", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* resolveForkStableReleaseMetadata("v1.2.3-hyprws.4"), {
      version: "1.2.3-hyprws.4",
      tag: "v1.2.3-hyprws.4",
      name: "T3 Code hyprws v1.2.3-hyprws.4",
      shortSha: "",
      isPrerelease: false,
      makeLatest: true,
    });
  }),
);

it("derives the next stable revision and rejects revision zero", () => {
  assert.equal(
    resolveNextForkStableTag("1.2.3", ["v1.2.3-hyprws.1", "v1.2.3-hyprws.4", "v1.2.4-hyprws.9"]),
    "v1.2.3-hyprws.5",
  );
  assert.equal(resolveNextForkStableTag("1.2.3", []), "v1.2.3-hyprws.1");
  assert.isNull(resolveNextForkStableTag("1.2.3-rc.1", []));
});

it.effect("rejects stable dispatch metadata that is not a fork stable tag", () =>
  Effect.gen(function* () {
    const error = yield* resolveForkStableReleaseMetadata("v1.2.3-hyprws.0").pipe(Effect.flip);

    assert.equal(error._tag, "InvalidForkReleaseInputError");
    assert.equal(error.message, "Stable fork releases require a vX.Y.Z-hyprws.N tag ref.");
  }),
);

it("resolves previous release tags independently for each fork channel", () => {
  const tags = [
    "v1.2.2-hyprws.9",
    "v1.2.3-hyprws.1",
    "v1.2.3-hyprws.2",
    "v1.2.3-hyprws-nightly.20260828.90",
    "v1.2.3-hyprws-nightly.20260829.4",
    "v1.2.3-nightly.20260829.5",
    "v1.2.3",
  ];

  assert.equal(resolvePreviousForkReleaseTag("stable", "v1.2.3-hyprws.3", tags), "v1.2.3-hyprws.2");
  assert.equal(
    resolvePreviousForkReleaseTag("nightly", "v1.2.3-hyprws-nightly.20260829.5", tags),
    "v1.2.3-hyprws-nightly.20260829.4",
  );
});

it.layer(NodeServices.layer)("fork release output", (it) => {
  it.effect("appends channel metadata and the previous tag to GITHUB_OUTPUT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-release-output-" });
      const outputPath = path.join(root, "github-output.txt");
      const metadata = resolveForkNightlyReleaseMetadata(
        "1.2.4",
        "20260829",
        17,
        "abcdef1234567890",
      );

      yield* writeForkReleaseOutput(metadata, "v1.2.4-hyprws-nightly.20260829.16", true).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITHUB_OUTPUT: outputPath } })),
        ),
      );

      assert.equal(
        yield* fs.readFileString(outputPath),
        [
          "version=1.2.4-hyprws-nightly.20260829.17",
          "tag=v1.2.4-hyprws-nightly.20260829.17",
          "name=T3 Code hyprws Nightly 1.2.4-hyprws-nightly.20260829.17 (abcdef123456)",
          "short_sha=abcdef123456",
          "previous_tag=v1.2.4-hyprws-nightly.20260829.16",
          "is_prerelease=true",
          "make_latest=false",
          "",
        ].join("\n"),
      );
    }),
  );
});
