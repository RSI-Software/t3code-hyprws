import { type CheckoutPhysicalIdentity } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CheckoutMutationCoordinator } from "../git/CheckoutMutationCoordinator.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class CheckoutMoveValidationError extends Schema.TaggedErrorClass<CheckoutMoveValidationError>()(
  "CheckoutMoveValidationError",
  { reason: Schema.String },
) {}

export const resolveCheckoutPhysicalIdentity = Effect.fn(
  "CheckoutMoveCoordinator.resolveCheckoutPhysicalIdentity",
)(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const handle = yield* registry.resolve({ cwd });
  const checkoutRoot = yield* fileSystem.realPath(handle.repository.rootPath);
  const [revisionOutput, branchOutput, commonDirOutput] = yield* Effect.all([
    handle.driver.execute({
      operation: "CheckoutMoveCoordinator.revision",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: checkoutRoot,
    }),
    handle.driver.execute({
      operation: "CheckoutMoveCoordinator.branch",
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      cwd: checkoutRoot,
      allowNonZeroExit: true,
    }),
    handle.driver.execute({
      operation: "CheckoutMoveCoordinator.commonDir",
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd: checkoutRoot,
    }),
  ]);
  const commonDir = yield* fileSystem.realPath(commonDirOutput.stdout.trim());
  const repositoryRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  return {
    repositoryRoot,
    checkoutRoot,
    revision: revisionOutput.stdout.trim(),
    branch: branchOutput.exitCode === 0 ? branchOutput.stdout.trim() || null : null,
  } satisfies CheckoutPhysicalIdentity;
});

export const withVerifiedCheckoutMove = Effect.fn(
  "CheckoutMoveCoordinator.withVerifiedCheckoutMove",
)(function* <A, E, R>(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly effect: (
    source: CheckoutPhysicalIdentity,
    destination: CheckoutPhysicalIdentity,
  ) => Effect.Effect<A, E, R>;
}) {
  const source = yield* resolveCheckoutPhysicalIdentity(input.sourcePath);
  const destinationSnapshot = yield* resolveCheckoutPhysicalIdentity(input.destinationPath);
  const coordinator = yield* CheckoutMutationCoordinator;
  const roots = [...new Set([source.checkoutRoot, destinationSnapshot.checkoutRoot])].sort();
  const withLeases = <B, F, Q>(effect: Effect.Effect<B, F, Q>) =>
    roots.reduceRight((leased, root) => coordinator.withLease(root, leased), effect);
  return yield* withLeases(
    Effect.gen(function* () {
      const currentSource = yield* resolveCheckoutPhysicalIdentity(input.sourcePath);
      const destination = yield* resolveCheckoutPhysicalIdentity(input.destinationPath);
      if (
        currentSource.revision !== source.revision ||
        currentSource.checkoutRoot !== source.checkoutRoot
      ) {
        return yield* new CheckoutMoveValidationError({
          reason: "effective checkout revision changed while waiting for mutation lease",
        });
      }
      if (currentSource.repositoryRoot !== destination.repositoryRoot) {
        return yield* new CheckoutMoveValidationError({
          reason: "destination belongs to another repository",
        });
      }
      if (
        destination.checkoutRoot !== destinationSnapshot.checkoutRoot ||
        destination.revision !== destinationSnapshot.revision
      ) {
        return yield* new CheckoutMoveValidationError({
          reason: "destination checkout revision changed while waiting for mutation lease",
        });
      }
      return yield* input.effect(currentSource, destination);
    }),
  );
});
