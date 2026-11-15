import { describe, expect, it, vi } from "vite-plus/test";

import { useForkThreadActionItemFork } from "./threadForkPalette.fork";

vi.mock("../hooks/useThreadActionMenu.fork", () => ({
  useThreadForkDispatchFork: () => vi.fn(),
}));
vi.mock("../hooks/useNowMinute", () => ({ useNowMinute: () => 0 }));
vi.mock("../state/session", () => ({ readEnvironmentScope: vi.fn() }));

describe("Fork thread palette entry", () => {
  it.each([null, undefined])("omits the action without an active thread (%s)", (thread) => {
    expect(useForkThreadActionItemFork(thread)).toBeNull();
  });
});
