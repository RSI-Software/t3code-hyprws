import { describe, expect, it } from "vite-plus/test";
import { shouldAutoFocusComposerOnThreadChange } from "./ChatView.focus.fork";

function element(
  tagName: string,
  options: { editable?: boolean; role?: string; within?: string } = {},
): Pick<Element, "tagName" | "closest" | "getAttribute"> & { isContentEditable?: boolean } {
  return {
    tagName,
    ...(options.editable === undefined ? {} : { isContentEditable: options.editable }),
    getAttribute: (name: string) => (name === "role" ? (options.role ?? null) : null),
    closest: () => (options.within !== undefined ? ({} as Element) : null),
  };
}

describe("shouldAutoFocusComposerOnThreadChange", () => {
  it("folds into upstream's window-focus predicate", () => {
    // The composer owns focus on thread change when nothing deliberate holds it.
    expect(shouldAutoFocusComposerOnThreadChange(null)).toBe(true);
    expect(shouldAutoFocusComposerOnThreadChange(element("BODY"))).toBe(true);
    expect(shouldAutoFocusComposerOnThreadChange(element("BUTTON"))).toBe(true);
  });

  it("yields to typing surfaces, drawer and panel terminals, and overlays", () => {
    expect(shouldAutoFocusComposerOnThreadChange(element("TEXTAREA"))).toBe(false);
    expect(shouldAutoFocusComposerOnThreadChange(element("DIV", { editable: true }))).toBe(false);
    expect(
      shouldAutoFocusComposerOnThreadChange(element("BUTTON", { within: "data-terminal-owner" })),
    ).toBe(false);
    expect(shouldAutoFocusComposerOnThreadChange(element("BUTTON", { within: "dialog" }))).toBe(
      false,
    );
  });
});
