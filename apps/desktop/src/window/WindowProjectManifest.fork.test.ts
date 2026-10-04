import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { WindowId } from "./WindowId.fork.ts";
import {
  buildWindowProjectManifest,
  decodeWindowProjectManifestJson,
  removeWindowProjectManifest,
  windowProjectManifestPath,
  writeWindowProjectManifest,
} from "./WindowProjectManifest.fork.ts";

const first = "00000000-0000-4000-8000-000000000001" as WindowId;
const second = "00000000-0000-4000-8000-000000000002" as WindowId;

describe("WindowProjectManifest", () => {
  it("lives under the runtime directory, keyed by pid", () => {
    assert.strictEqual(
      windowProjectManifestPath("/run/user/1000/", 77),
      "/run/user/1000/t3code/windows-77.json",
    );
    assert.isNull(windowProjectManifestPath(undefined, 77));
    assert.isNull(windowProjectManifestPath("  ", 77));
  });

  it("lists every window with an address or a scope, in id order", () => {
    const manifest = buildWindowProjectManifest({
      pid: 77,
      addresses: new Map([[second, "0xb"]]),
      scopes: new Map([[first, { kind: "all" } as const]]),
    });
    assert.deepEqual(manifest, {
      version: 1,
      pid: 77,
      windows: [
        { windowId: first, address: null, scope: { kind: "all" } },
        { windowId: second, address: "0xb", scope: null },
      ],
    });
  });

  it.effect("replaces the file whole, narrows its directory, and removes it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "window-manifest-" });
      const path = windowProjectManifestPath(root, 77)!;
      yield* fileSystem.makeDirectory(`${root}/t3code`, { mode: 0o755 });
      const manifest = buildWindowProjectManifest({
        pid: 77,
        addresses: new Map([[first, "0xa"]]),
        scopes: new Map(),
      });

      yield* writeWindowProjectManifest(path, manifest);
      yield* writeWindowProjectManifest(path, manifest);

      assert.deepEqual(
        yield* decodeWindowProjectManifestJson(yield* fileSystem.readFileString(path)),
        manifest,
      );
      assert.deepEqual(yield* fileSystem.readDirectory(`${root}/t3code`), ["windows-77.json"]);
      assert.equal((yield* fileSystem.stat(`${root}/t3code`)).mode & 0o777, 0o700);
      yield* fileSystem.writeFileString(`${path}.tmp`, "partial");
      yield* removeWindowProjectManifest(path);
      yield* removeWindowProjectManifest(path);
      assert.deepEqual(yield* fileSystem.readDirectory(`${root}/t3code`), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
