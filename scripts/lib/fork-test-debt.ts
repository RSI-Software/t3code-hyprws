// The baseline for the upstream-test append-only rule. The fork already edits 56 upstream test
// files in place, and a rule that refuses every one of them on the first commit that touches an
// unrelated line is a rule nobody can run. `scripts/fork-test-debt.json` names those files, so it
// is the allow-list itself rather than a second list beside it: a file leaves the baseline by
// leaving `editedInPlace`, which is the same edit that records the migration
// (RSI-Software/t3code-hyprws#697).

/** The tracked baseline the allow-list is read from. */
export const TEST_DEBT_BASELINE = "scripts/fork-test-debt.json";

/**
 * The files the append-only rule tolerates. An unparseable or absent baseline yields an empty set,
 * which refuses more than it should rather than less: a missing allow-list must never read as a
 * licence.
 *
 * `rewrittenAssertions` and `deletions` beside it record which upstream expectations the fork
 * inverted or removed; both are records for the migration, never a licence, so nothing here reads
 * them.
 */
export const parseTestDebtBaseline = (source: string): ReadonlySet<string> => {
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object") return new Set();
    const entries = (parsed as { readonly editedInPlace?: unknown }).editedInPlace;
    if (!Array.isArray(entries)) return new Set();
    return new Set(entries.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
};
