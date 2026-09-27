// Fork-only: the Fork menu item is built only for Claude and Codex threads
// and disables while a fork RPC is in flight.
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forkThreadMenuItems,
  forkThreadMenuStateFork,
  type ForkableThreadProviderState,
} from "./threadActionMenu.logic.fork.ts";

const state = (
  fork: ForkableThreadProviderState | null | undefined,
): Parameters<typeof forkThreadMenuItems>[0] =>
  fork === undefined ? {} : ({ fork } as Parameters<typeof forkThreadMenuItems>[0]);

describe("forkThreadMenuStateFork", () => {
  it("accepts Claude and Codex", () => {
    expect(forkThreadMenuStateFork(ProviderDriverKind.make("claudeAgent"), false)).toEqual({
      provider: ProviderDriverKind.make("claudeAgent"),
      inFlight: false,
    });
    expect(forkThreadMenuStateFork(ProviderDriverKind.make("codex"), true)).toEqual({
      provider: ProviderDriverKind.make("codex"),
      inFlight: true,
    });
  });

  it("rejects every other provider and a missing one", () => {
    expect(forkThreadMenuStateFork(ProviderDriverKind.make("opencode"), false)).toBeNull();
    expect(forkThreadMenuStateFork(ProviderDriverKind.make("gemini"), false)).toBeNull();
    expect(forkThreadMenuStateFork(null, false)).toBeNull();
    expect(forkThreadMenuStateFork(undefined, false)).toBeNull();
  });
});

describe("forkThreadMenuItems", () => {
  it("builds a disabled entry while a fork is in flight", () => {
    expect(
      forkThreadMenuItems(state({ provider: ProviderDriverKind.make("codex"), inFlight: true })),
    ).toEqual([{ id: "fork", label: "Fork thread", icon: "git-fork", disabled: true }]);
  });

  it("builds an enabled entry when idle", () => {
    expect(
      forkThreadMenuItems(
        state({ provider: ProviderDriverKind.make("claudeAgent"), inFlight: false }),
      ),
    ).toEqual([{ id: "fork", label: "Fork thread", icon: "git-fork", disabled: false }]);
  });

  it("builds nothing for non-forkable providers", () => {
    expect(forkThreadMenuItems(state(null))).toEqual([]);
    expect(forkThreadMenuItems(state(undefined))).toEqual([]);
  });
});
