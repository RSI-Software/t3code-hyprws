import { EnvironmentId, ThreadId, type ThreadCheckoutMove } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThread, EnvironmentThreadShell } from "./models.ts";
import { mergeEnvironmentThread } from "./threadDetail.ts";
import {
  boundedTerminalAttachmentId,
  checkoutMoveExpectedRoot,
  isCheckoutMoveInFlight,
  isStaleCheckoutMoveRejection,
  presentCheckoutMove,
  shouldFollowCommittedCheckout,
} from "./checkoutMove.ts";

const identity = (checkoutRoot: string) => ({
  repositoryRoot: "/repo",
  checkoutRoot,
  revision: "revision",
  branch: "feature",
});

const move = (
  status: ThreadCheckoutMove["status"],
  options?: { readonly dormant?: boolean },
): ThreadCheckoutMove => ({
  requestId: "move-1" as never,
  source: identity("/repo/main"),
  sourceThreadBranch: "main",
  sourceThreadWorktreePath: null,
  requestedPath: "/repo/feature",
  destination: identity("/repo/feature"),
  expectedCheckoutRoot: "/repo/main",
  status,
  completedSteps: status === "partial" ? ["provider"] : [],
  effectiveProvider: options?.dormant
    ? (null as never)
    : status === "partial"
      ? identity("/repo/feature")
      : identity("/repo/main"),
  providerAvailable: status === "partial" ? false : undefined,
  requestedAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:01.000Z",
});

describe("boundedTerminalAttachmentId", () => {
  it("preserves ordinary identities and bounds schema-valid long terminal ids", () => {
    expect(boundedTerminalAttachmentId("device-a", "term-1")).toBe("device-a:term-1");
    const first = boundedTerminalAttachmentId("device-a", "x".repeat(128));
    const second = boundedTerminalAttachmentId("device-b", "x".repeat(128));
    expect(first.length).toBeLessThanOrEqual(128);
    expect(second.length).toBeLessThanOrEqual(128);
    expect(first).not.toBe(second);
  });
});

describe("checkout move client policy", () => {
  it("locks controls until commit and follows only committed moves", () => {
    expect(isCheckoutMoveInFlight(move("queued"))).toBe(true);
    expect(isCheckoutMoveInFlight(move("preparing"))).toBe(true);
    expect(shouldFollowCommittedCheckout({ mode: "follow", move: move("partial") })).toBe(false);
    expect(shouldFollowCommittedCheckout({ mode: "pin", move: move("committed") })).toBe(false);
    expect(shouldFollowCommittedCheckout({ mode: "follow", move: move("committed") })).toBe(true);
  });

  it("recognizes stale physical and reverse-move rejections", () => {
    expect(isStaleCheckoutMoveRejection("Checkout move identity validation failed")).toBe(true);
    expect(
      isStaleCheckoutMoveRejection("reverse move no longer matches the effective checkout"),
    ).toBe(true);
    expect(isStaleCheckoutMoveRejection("zmux is unavailable")).toBe(false);
  });

  it("reports effective partial state and exposes the matching recovery action", () => {
    const partial = move("partial");
    expect(presentCheckoutMove(partial)).toMatchObject({
      action: "retry",
      inFlight: false,
      label: "Partially moved · Retry",
      detail: expect.stringContaining("Effective provider: feature"),
    });
    expect(presentCheckoutMove(partial)?.detail).toContain("provider unavailable");
    expect(checkoutMoveExpectedRoot(partial)).toBe("/repo/main");
    expect(presentCheckoutMove(move("committed"))).toMatchObject({
      action: "undo",
      label: "Moved main → feature · Undo",
    });
  });

  it("describes a committed dormant move without inventing provider availability", () => {
    const dormant = {
      ...move("committed", { dormant: true }),
      completedSteps: ["metadata"] as const,
    };
    expect(presentCheckoutMove(dormant)).toMatchObject({
      action: "undo",
      detail: expect.stringContaining("No provider is running; the next turn starts at feature."),
    });
    expect(checkoutMoveExpectedRoot(dormant)).toBe("/repo/feature");
  });

  it("takes checkout movement from the authoritative shell projection", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const id = ThreadId.make("thread-1");
    const detail = {
      environmentId,
      id,
      checkoutMove: move("queued"),
    } as EnvironmentThread;
    const shellMove = move("committed", { dormant: true });
    const shell = {
      environmentId,
      id,
      branch: "feature",
      worktreePath: "/repo/feature",
      checkoutMove: shellMove,
    } as EnvironmentThreadShell;

    expect(mergeEnvironmentThread(detail, shell)).toMatchObject({
      branch: "feature",
      worktreePath: "/repo/feature",
      checkoutMove: shellMove,
    });
  });
});
