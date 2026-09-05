import * as Effect from "effect/Effect";

interface RenamedBranchResult {
  readonly type: "return";
  readonly value: Effect.Effect<{ readonly branch: string }>;
}

interface RenameBranchMock {
  readonly mock: {
    readonly results: ReadonlyArray<
      RenamedBranchResult | { readonly type: "throw" | "incomplete"; readonly value: unknown }
    >;
  };
}

/** The fork reads the checkout back after a rename: it sits on the last renamed branch. */
export const forkLastRenamedBranchStatus = (renameBranch: RenameBranchMock) => () =>
  (
    renameBranch.mock.results.findLast(
      (result): result is RenamedBranchResult => result.type === "return",
    )?.value ?? Effect.succeed({ branch: "t3code/1234abcd" })
  ).pipe(
    Effect.map(({ branch }) => ({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: branch,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    })),
  );
