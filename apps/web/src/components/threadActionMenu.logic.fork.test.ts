// Fork-only: the Fork menu item is built once the thread has run on a
// configured provider, disabled while the thread is busy (active run or
// pending request) or while a fork is in flight.
import { ProviderDriverKind, ProviderInstanceId, RunId } from "@t3tools/contracts";
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
const OPENCODE = ProviderDriverKind.make("opencode");
const NOW = "2026-08-20T00:00:00.000Z";

/** Mirror of the upstream test's base state, with the fork slice filled in. */
const baseFork: ForkableThreadProviderState = {
  provider: CODEX,
  busy: false,
  inFlight: false,
};

const baseState: Pick<ThreadActionMenuState, "fork"> = { fork: baseFork };

const completedRun: NonNullable<ForkThreadShell["latestRun"]> = {
  runId: RunId.make("run-1"),
  status: "completed",
  requestedAt: "2026-08-19T23:00:00.000Z",
  startedAt: "2026-08-19T23:00:01.000Z",
  completedAt: "2026-08-19T23:05:00.000Z",
  assistantMessageId: null,
};

const runtime = (
  status: NonNullable<ForkThreadShell["runtime"]>["status"],
): ForkThreadShell["runtime"] => ({
  status,
  activeRunId: status === "idle" ? null : RunId.make("run-2"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: null,
  lastError: null,
  updatedAt: NOW,
});

/** The quiescence slice the busy check reads: a quiet thread with one finished run. */
const shell = (overrides: Partial<ForkThreadShell> = {}): ForkThreadShell => ({
  latestRun: completedRun,
  runtime: runtime("idle"),
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: null,
  ...overrides,
});

describe("forkThreadMenuStateFork", () => {
  it("builds state for any configured provider once the thread has run", () => {
    expect(forkThreadMenuStateFork(CODEX, false, shell(), NOW)).toEqual({
      provider: CODEX,
      busy: false,
      inFlight: false,
    });
    // V2 forks portably where the provider cannot fork natively.
    expect(forkThreadMenuStateFork(OPENCODE, false, shell(), NOW)).not.toBeNull();
    expect(forkThreadMenuStateFork(null, false, shell(), NOW)).toBeNull();
    expect(forkThreadMenuStateFork(CODEX, false, shell({ latestRun: null }), NOW)).toBeNull();
  });

  it.each([
    { name: "a running run", shell: shell({ runtime: runtime("running") }) },
    { name: "a starting run", shell: shell({ runtime: runtime("starting") }) },
    { name: "a queued run", shell: shell({ runtime: runtime("queued") }) },
    { name: "a run waiting on the user", shell: shell({ runtime: runtime("waiting") }) },
    { name: "a pending approval", shell: shell({ hasPendingApprovals: true }) },
    { name: "a pending user input", shell: shell({ hasPendingUserInput: true }) },
    {
      name: "an unadopted user message",
      shell: shell({ latestUserMessageAt: "2026-08-19T23:59:30.000Z" }),
    },
  ])("marks the thread busy for $name", ({ shell: busyShell }) => {
    expect(forkThreadMenuStateFork(CODEX, false, busyShell, NOW)?.busy).toBe(true);
  });

  it("passes the in-flight flag through", () => {
    expect(forkThreadMenuStateFork(CODEX, true, shell(), NOW)?.inFlight).toBe(true);
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

  it("omits the item entirely without fork state", () => {
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
