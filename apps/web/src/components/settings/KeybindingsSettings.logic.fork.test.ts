import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { buildKeybindingCommandOptions, buildKeybindingRows } from "./KeybindingsSettings.logic";

describe("KeybindingsSettings.logic", () => {
  it("orders Usage bindings the same whatever the input order", () => {
    const orders = [DEFAULT_RESOLVED_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS.toReversed()];
    const [rows, reversedRows] = orders.map((bindings) =>
      buildKeybindingRows(bindings, "usage").map((row) => row.command),
    );
    const [options, reversedOptions] = orders.map((bindings) =>
      buildKeybindingCommandOptions(bindings).filter((command) => command.startsWith("usage.")),
    );
    expect(reversedRows).toEqual(rows);
    expect(reversedOptions).toEqual(options);
  });
});
