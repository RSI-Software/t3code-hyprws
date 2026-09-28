import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import { migrateRenamedKeybindingCommands } from "./keybindings.fork.ts";

// Fork-owned coverage for the window bindings. Upstream removed its
// default-assignment snapshot in "test(server): remove keybinding default
// assignment snapshot" (#10065), which is where this assertion used to ride;
// keeping it in a fork sibling means upstream churn in the shared test file
// can never take the fork default with it.
describe("fork keybinding defaults", () => {
  const defaultsByCommand = new Map(
    Keybindings.DEFAULT_KEYBINDINGS.map((binding) => [binding.command, binding.key] as const),
  );

  it("ships the window bindings", () => {
    assert.equal(defaultsByCommand.get("window.new"), "mod+shift+w");
    assert.equal(defaultsByCommand.get("window.openInNew"), "mod+alt+o");
  });

  it("gives New Window a chord no other default uses", () => {
    const owners = Keybindings.DEFAULT_KEYBINDINGS.filter(
      (binding) => binding.key === "mod+shift+w",
    ).map((binding) => binding.command);
    assert.deepEqual(owners, ["window.new"]);
  });
});

describe("fork keybinding command renames", () => {
  it("rewrites a renamed command and leaves the rest of the file as written", () => {
    const raw = `[
  // opens the project in a new window
  { "key": "mod+alt+p", "command" : "project.openWindow", "when": "!terminalFocus" },
  { "key": "mod+j", "command": "terminal.toggle" },
]`;
    assert.equal(
      migrateRenamedKeybindingCommands(raw),
      raw.replace('"project.openWindow"', '"window.openInNew"'),
    );
  });

  it("leaves a key or when clause that only mentions an old id alone", () => {
    const raw = `[{ "key": "mod+x", "command": "terminal.toggle", "when": "project.openWindow" }]`;
    assert.equal(migrateRenamedKeybindingCommands(raw), raw);
  });
});

it.layer(NodeServices.layer)("fork keybinding config migration", (it) => {
  it.effect("loads a saved binding for a renamed command without an invalid-entry issue", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        `[{ "key": "mod+alt+p", "command": "project.openWindow", "when": "!terminalFocus" }]`,
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "window.openInNew" && entry.shortcut.key === "p",
        ),
      );
    }).pipe(
      Effect.provide(
        Keybindings.layer.pipe(
          Layer.provideMerge(
            Layer.fresh(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3code-keybindings-fork-test-" }),
            ),
          ),
        ),
      ),
    ),
  );
});
