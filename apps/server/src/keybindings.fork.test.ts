import { assert, describe, it } from "@effect/vitest";

import * as Keybindings from "./keybindings.ts";

// Fork-owned coverage for the project-window binding. Upstream removed its
// default-assignment snapshot in "test(server): remove keybinding default
// assignment snapshot" (#10065), which is where this assertion used to ride;
// keeping it in a fork sibling means upstream churn in the shared test file
// can never take the fork default with it.
describe("fork keybinding defaults", () => {
  it("ships the project window binding", () => {
    const defaultsByCommand = new Map(
      Keybindings.DEFAULT_KEYBINDINGS.map((binding) => [binding.command, binding.key] as const),
    );

    assert.equal(defaultsByCommand.get("project.openWindow"), "mod+alt+o");
  });
});
