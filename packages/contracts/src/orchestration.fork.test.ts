import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ClientOrchestrationCommand } from "./orchestration.ts";

const decode = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
it.effect("checkout move clients cannot forge resolved identities", () =>
  Effect.gen(function* () {
    const requested = yield* decode({
      type: "thread.checkout-move.request",
      commandId: "move-1",
      threadId: "thread-1",
      requestedPath: "/repo/worktree",
      expectedCheckoutRoot: "/repo",
      createdAt: "2026-09-05T00:00:00.000Z",
    });
    assert.strictEqual(requested.type, "thread.checkout-move.request");
    const forged = yield* Effect.exit(
      decode({
        type: "thread.checkout-move.prepare",
        commandId: "move-2",
        requestId: "move-1",
        threadId: "thread-1",
        source: { repositoryRoot: "/repo", checkoutRoot: "/repo", revision: "a", branch: null },
        destination: {
          repositoryRoot: "/repo",
          checkoutRoot: "/repo/worktree",
          revision: "a",
          branch: "feature",
        },
        queued: false,
        createdAt: "2026-09-05T00:00:00.000Z",
      }),
    );
    assert.strictEqual(forged._tag, "Failure");
  }),
);
