import type { CwdCommandRunner as CommandRunner } from "./fork-command.ts";

const FULL_SHA = /^[0-9a-f]{40,64}$/;
const ARCHIVE_PREFIX = "refs/heads/archive/hyprws-pre-rewrite-";

export type RewriteArchiveTrunkOutcome = "pending" | "applied" | "failed";

export interface RewriteArchiveBinding {
  readonly ref: string;
  readonly sha: string;
  /** Remote readback captured by rewrite-kind unblock-apply. */
  readonly verification?: {
    readonly observedSha: string;
    readonly trunkOutcome: RewriteArchiveTrunkOutcome;
  };
}

export const rewriteArchiveRef = (expectedOld: string): string => {
  if (!FULL_SHA.test(expectedOld))
    throw new Error("rewrite archive requires a full expected-old SHA");
  return `${ARCHIVE_PREFIX}${expectedOld.slice(0, 12)}`;
};

export const rewriteArchiveBinding = (expectedOld: string): RewriteArchiveBinding => ({
  ref: rewriteArchiveRef(expectedOld),
  sha: expectedOld,
});

export const validateRewriteArchiveBinding = (value: unknown, expectedOld: string): void => {
  if (typeof value !== "object" || value === null)
    throw new Error("rewrite archive binding is invalid");
  const archive = value as Partial<RewriteArchiveBinding>;
  if (archive.sha !== expectedOld || archive.ref !== rewriteArchiveRef(expectedOld))
    throw new Error("rewrite archive binding does not match expected-old");
  const verification = archive.verification;
  if (
    verification !== undefined &&
    (typeof verification !== "object" ||
      verification === null ||
      verification.observedSha !== expectedOld ||
      !["pending", "applied", "failed"].includes(verification.trunkOutcome))
  )
    throw new Error("rewrite archive verification is invalid");
};

const detailOf = (result: ReturnType<CommandRunner["run"]>): string =>
  result.error?.message ?? (result.stderr.trim() || result.stdout.trim());

const remoteArchiveSha = (runner: CommandRunner, worktree: string, ref: string): string | null => {
  const args = ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", ref] as const;
  const result = runner.run("git", args, worktree);
  if (result.status !== 0 || result.error !== undefined) {
    const detail = detailOf(result);
    throw new Error(
      `read rewrite archive ${ref} failed${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  const output = result.stdout.trim();
  return output.length === 0 ? null : (output.split(/\s+/, 1)[0] ?? null);
};

/**
 * Retain the pre-rewrite trunk with a missing-ref lease, then verify the remote value.
 * A retry accepts only the exact binding already published by the earlier attempt.
 */
export const retainRewriteArchive = (
  runner: CommandRunner,
  worktree: string,
  binding: RewriteArchiveBinding,
): NonNullable<RewriteArchiveBinding["verification"]> => {
  validateRewriteArchiveBinding(binding, binding.sha);
  const existing = remoteArchiveSha(runner, worktree, binding.ref);
  if (existing !== null && existing !== binding.sha)
    throw new Error(
      `rewrite archive collision: ${binding.ref} is ${existing}, expected ${binding.sha}`,
    );
  if (existing === null) {
    const args = [
      "-c",
      "core.commentChar=auto",
      "push",
      `--force-with-lease=${binding.ref}:`,
      "origin",
      `${binding.sha}:${binding.ref}`,
    ] as const;
    const result = runner.run("git", args, worktree);
    if (result.status !== 0 || result.error !== undefined) {
      const detail = detailOf(result);
      throw new Error(
        `create rewrite archive ${binding.ref} failed${detail.length === 0 ? "" : `: ${detail}`}`,
      );
    }
  }
  const observedSha = remoteArchiveSha(runner, worktree, binding.ref);
  if (observedSha !== binding.sha)
    throw new Error(
      `rewrite archive readback failed: ${binding.ref} is ${observedSha ?? "absent"}, expected ${binding.sha}`,
    );
  return { observedSha, trunkOutcome: "pending" };
};
