import { describe, expect, it, vi } from "vite-plus/test";

import { buildOpenThreadWindowActionItemFork } from "./threadWindowPalette.fork";

vi.mock("../desktopWindows.fork", () => ({
  canOpenDesktopWindow: () => true,
  openThreadInNewWindow: vi.fn(),
}));

describe("Open thread window palette entry", () => {
  it.each([null, undefined])("omits the action without an active thread (%s)", (thread) => {
    expect(buildOpenThreadWindowActionItemFork(thread)).toBeNull();
  });
});
