import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import {
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions.ts";
const ScriptTestLayer = Layer.mergeAll(NodeServices.layer, TestConsole.layer);
const PackageJsonSchema = Schema.Record(Schema.String, Schema.Unknown);
const PackageJsonPrettyJson = fromJsonStringPretty(PackageJsonSchema);
const decodePackageJson = Schema.decodeEffect(PackageJsonPrettyJson);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);
const writePackageJsonFixtures = Effect.fn("writePackageJsonFixtures")(function* (
  rootDir: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(rootDir, relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(
      filePath,
      `${yield* encodePackageJson({
        name: relativePath,
        version,
        private: true,
      })}\n`,
    );
  }
});
const readReleaseVersions = Effect.fn("readReleaseVersions")(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versions = new Map<string, string>();
  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(rootDir, relativePath);
    const packageJson = yield* fs.readFileString(filePath).pipe(Effect.flatMap(decodePackageJson));
    versions.set(relativePath, String(packageJson.version));
  }
  return versions;
});
it.layer(ScriptTestLayer)("update-release-package-versions", (it) => {
  it.effect("accepts stable and nightly fork release versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const version of ["1.2.3-hyprws.4", "1.2.4-hyprws-nightly.20260829.17"]) {
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "update-fork-release-package-versions-",
        });
        yield* writePackageJsonFixtures(baseDir, "0.0.1");
        const result = yield* updateReleasePackageVersions(version, { rootDir: baseDir });
        const versions = yield* readReleaseVersions(baseDir);
        assert.deepStrictEqual(result, { changed: true });
        assert.deepStrictEqual(
          [...versions.values()],
          releasePackageFiles.map(() => version),
        );
      }
    }),
  );
});
