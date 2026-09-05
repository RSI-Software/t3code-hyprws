import { CommandId, ThreadId, type CheckoutPhysicalIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  decideCheckoutMoveComplete,
  decideCheckoutMovePrepare,
  type CheckoutMoveProjection,
} from "./CheckoutMoveState.ts";

const source: CheckoutPhysicalIdentity = {
  repositoryRoot: "/repo",
  checkoutRoot: "/repo/a",
  revision: "aaa",
  branch: "feature/a",
};
const destination: CheckoutPhysicalIdentity = {
  repositoryRoot: "/repo",
  checkoutRoot: "/repo/b",
  revision: "bbb",
  branch: "feature/b",
};
const move = {
  requestId: CommandId.make("move-1"),
  source,
  requestedPath: destination.checkoutRoot,
  destination: null,
  expectedCheckoutRoot: source.checkoutRoot,
  status: "queued" as const,
  completedSteps: [],
  effectiveProvider: null,
  requestedAt: "2026-09-05T07:00:00.000Z",
  updatedAt: "2026-09-05T07:00:00.000Z",
};
const base: CheckoutMoveProjection = { effective: source, move };

const prepare = {
  type: "thread.checkout-move.prepare" as const,
  commandId: CommandId.make("prepare-1"),
  threadId: ThreadId.make("thread-1"),
  requestId: move.requestId,
  source,
  destination,
  queued: false,
  createdAt: "2026-09-05T07:01:00.000Z",
};

describe("CheckoutMoveState", () => {
  it("prepares only the current durable request and exact physical identities", () => {
    expect(decideCheckoutMovePrepare({ projection: base, command: prepare })).toMatchObject({
      status: "accepted",
    });
    expect(
      decideCheckoutMovePrepare({
        projection: base,
        command: { ...prepare, requestId: CommandId.make("other") },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      decideCheckoutMovePrepare({
        projection: base,
        command: { ...prepare, destination: { ...destination, revision: "changed" } },
      }),
    ).toMatchObject({ status: "accepted" });
  });

  it("returns a preparing request to queued when a turn wins the lease race", () => {
    const prepared = decideCheckoutMovePrepare({ projection: base, command: prepare });
    expect(prepared.status).toBe("accepted");
    if (prepared.status !== "accepted") return;
    const requeued = decideCheckoutMovePrepare({
      projection: { effective: source, move: prepared.event.move },
      command: { ...prepare, commandId: CommandId.make("requeue-1"), queued: true },
    });
    expect(requeued).toMatchObject({
      status: "accepted",
      event: { move: { requestId: move.requestId, status: "queued" } },
    });
  });

  it("makes completion idempotency include availability and detail", () => {
    const prepared = decideCheckoutMovePrepare({ projection: base, command: prepare });
    expect(prepared.status).toBe("accepted");
    if (prepared.status !== "accepted") return;
    const command = {
      type: "thread.checkout-move.complete" as const,
      commandId: CommandId.make("complete-1"),
      threadId: prepare.threadId,
      requestId: move.requestId,
      source,
      destination,
      status: "partial" as const,
      completedSteps: ["provider" as const],
      effectiveProvider: destination,
      providerAvailable: false,
      detail: "runtime unavailable",
      createdAt: "2026-09-05T07:02:00.000Z",
    };
    const completed = decideCheckoutMoveComplete({
      projection: { effective: source, move: prepared.event.move },
      command,
    });
    expect(completed.status).toBe("accepted");
    if (completed.status !== "accepted") return;
    const projected = { effective: source, move: completed.event.move };
    expect(decideCheckoutMoveComplete({ projection: projected, command })).toEqual({
      status: "idempotent",
      event: null,
    });
    expect(
      decideCheckoutMoveComplete({
        projection: projected,
        command: { ...command, providerAvailable: true },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      decideCheckoutMoveComplete({
        projection: projected,
        command: { ...command, detail: "different" },
      }),
    ).toMatchObject({ status: "rejected" });
  });
});
