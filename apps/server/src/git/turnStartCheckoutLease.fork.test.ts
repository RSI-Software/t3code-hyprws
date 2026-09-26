import { VcsProcessSpawnError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import type { VcsDriverHandle } from "../vcs/VcsDriverRegistry.ts";
import { resolveTurnCheckoutFork } from "./turnStartCheckoutLease.fork.ts";

describe("resolveTurnCheckoutFork", () => {
  it.effect("leases the removed worktree's own path when no repository is found", () =>
    Effect.gen(function* () {
      const checkout = yield* resolveTurnCheckoutFork(
        {
          resolve: (input) =>
            Effect.fail(
              new VcsUnsupportedOperationError({
                operation: "VcsDriverRegistry.resolve",
                kind: "unknown",
                detail: `No supported VCS repository was detected at ${input.cwd}.`,
              }),
            ),
        },
        "/gone",
      );
      expect(checkout.repository.rootPath).toBe("/gone");
    }),
  );

  it.effect("leases the resolved repository root", () =>
    Effect.gen(function* () {
      const checkout = yield* resolveTurnCheckoutFork(
        {
          resolve: () =>
            Effect.succeed({ repository: { rootPath: "/repo" } } as unknown as VcsDriverHandle),
        },
        "/repo/wt",
      );
      expect(checkout.repository.rootPath).toBe("/repo");
    }),
  );

  it.effect("rejects the turn typed on any other resolve error, keeping the detail", () =>
    Effect.gen(function* () {
      const error = yield* resolveTurnCheckoutFork(
        {
          resolve: () =>
            Effect.fail(
              new VcsProcessSpawnError({
                operation: "x",
                command: "git",
                cwd: "/repo",
                cause: new Error("spawn"),
              }),
            ),
        },
        "/repo",
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.detail).toContain("/repo");
      expect(error.cause).toBeInstanceOf(VcsProcessSpawnError);
    }),
  );
});
