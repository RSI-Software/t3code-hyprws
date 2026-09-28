// Fork-only: the Fork menu item is built only for Claude and Codex threads,
// disabled while the thread is busy (running/queued turn or pending request)
// or while a fork RPC is in flight.
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadActionMenuState } from "./threadActionMenu.logic.ts";
import {
  forkThreadMenuItems,
  forkThreadMenuStateFork,
  openInNewWindowMenuItems,
  type ForkableThreadProviderState,
  type ForkThreadShell,
} from "./threadActionMenu.logic.fork.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

/** Mirror of the upstream test's base state, with the fork slice filled in. */
const baseFork: ForkableThreadProviderState = {
  provider: CODEX,
  busy: false,
  inFlight: false,
};

const baseState: Pick<ThreadActionMenuState, "fork"> = { fork: baseFork };

/** Minimal shell doubles: the busy check only reads the quiescence slice. */
const shell = (overrides: {
  readonly latestTurn?: unknown;
  readonly session?: unknown;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly latestUserMessageAt?: string | null;
}): ForkThreadShell =>
  ({
    latestTurn: overrides.latestTurn ?? null,
    session: overrides.session ?? null,
    hasPendingApprovals: overrides.hasPendingApprovals ?? false,
    hasPendingUserInput: overrides.hasPendingUserInput ?? false,
    latestUserMessageAt: overrides.latestUserMessageAt ?? null,
  }) as ForkThreadShell;

describe("forkThreadMenuStateFork", () => {
  it("builds state only for Claude and Codex threads", () => {
    expect(forkThreadMenuStateFork(CODEX, false, shell({}), "2026-08-20T00:00:00Z")).toMatchObject({
      provider: CODEX,
      busy: false,
      inFlight: false,
    });
    expect(
      forkThreadMenuStateFork(CLAUDE, false, shell({}), "2026-08-20T00:00:00Z"),
    ).not.toBeNull();
    expect(
      forkThreadMenuStateFork(ProviderDriverKind.make("opencode"), false, shell({}), "x"),
    ).toBeNull();
    expect(forkThreadMenuStateFork(null, false, shell({}), "x")).toBeNull();
  });

  it.each([
    { name: "a running turn", shell: shell({ latestTurn: { state: "running" } }) },
    { name: "a running session", shell: shell({ session: { status: "running" } }) },
    { name: "a starting session", shell: shell({ session: { status: "starting" } }) },
    {
      name: "a session holding an active turn",
      shell: shell({ session: { status: "stopped", activeTurnId: "turn-1" } }),
    },
    { name: "a pending approval", shell: shell({ hasPendingApprovals: true }) },
    { name: "a pending user input", shell: shell({ hasPendingUserInput: true }) },
    {
      name: "a queued user message",
      shell: shell({ latestUserMessageAt: new Date().toISOString() }),
    },
  ])("marks the thread busy for $name", ({ shell: busyShell }) => {
    expect(forkThreadMenuStateFork(CODEX, false, busyShell, new Date().toISOString())?.busy).toBe(
      true,
    );
  });

  it("passes the in-flight flag through", () => {
    expect(forkThreadMenuStateFork(CODEX, true, shell({}), "2026-08-20T00:00:00Z")?.inFlight).toBe(
      true,
    );
  });
});

describe("forkThreadMenuItems", () => {
  it("renders a disabled Fork item while busy or in flight", () => {
    expect(forkThreadMenuItems(baseState)).toEqual([
      { id: "fork", label: "Fork thread", icon: "git-fork", disabled: false },
    ]);
    expect(forkThreadMenuItems({ fork: { ...baseFork, busy: true } })[0]?.disabled).toBe(true);
    expect(forkThreadMenuItems({ fork: { ...baseFork, inFlight: true } })[0]?.disabled).toBe(true);
  });

  it("omits the item entirely for other providers", () => {
    expect(forkThreadMenuItems({ fork: null })).toEqual([]);
    expect(forkThreadMenuItems({})).toEqual([]);
  });
});

describe("openInNewWindowMenuItems", () => {
  it("offers Open in New Window only where desktop windows can open", () => {
    expect(openInNewWindowMenuItems({ openInNewWindow: true }).map((item) => item.id)).toEqual([
      "open-in-new-window",
    ]);
    expect(openInNewWindowMenuItems({ openInNewWindow: false })).toEqual([]);
    expect(openInNewWindowMenuItems({})).toEqual([]);
  });
});
