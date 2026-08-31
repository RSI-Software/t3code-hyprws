# Fork strategy scorecard

> Current system graded against the [fork strategy](./fork-strategy.md) target, ordered as a
> migration sequence. Update the grades and snapshot when the gap moves.

**Legend** · Grades A–F · Value 💎💎💎 major / 💎💎 solid / 💎 nice · Effort 🟢 easy / 🟡 moderate / 🔴 heavy

Waves order the work: remove recurring friction first, then build the instruments that make later
calls evidence-based, then convert prose contracts to machine contracts, and restructure only once
the instruments prove where it pays. No hurry; each wave stands on its own.

## Wave 1 — quick wins

| Dimension           | Now | Target | Value  | Effort | Gap                                                                                                                                          |
| ------------------- | :-: | :----: | :----: | :----: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Regenerable files   |  D  |   A    | 💎💎💎 |   🟢   | `pnpm-lock.yaml` is 3-way merged every sync: a guaranteed conflict carrying zero fork intent. Adopt the rule: re-derive, never merge.        |
| Operational records | C+  |   A    |  💎💎  |   🟢   | Automatic syncs already record to run summaries, but human rehearsal records still land as stack commits. Route them to issues or summaries. |
| Release provenance  |  B  |   A    |   💎   |   🟢   | Release bodies name the base tag but not a delta revision. Stamp a stack range-hash so an old release's exact patchset is addressable.       |
| Granularity policy  | B+  |   A−   |   💎   |   🟢   | Practice is already correct — small commits, never squashed. Write it down: seam commits stay atomic; fork-only paths are free.              |

## Wave 2 — instruments

| Dimension             | Now | Target | Value  | Effort | Gap                                                                                                                                                    |
| --------------------- | :-: | :----: | :----: | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Seam-pressure metrics |  D  |   A    | 💎💎💎 |   🟡   | No metrics exist; refactor-vs-automate calls run on feel. A churn × shared-file report per domain is the prerequisite for every later structural call. |
| Delta-log             |  B  |   A    |  💎💎  |   🟡   | The branch is the only delta identity and each rebase erases its history. Append one record per accepted state; pairs with release provenance.         |

## Wave 3 — machine contracts

| Dimension        | Now | Target | Value  | Effort | Gap                                                                                                                                                                                                              |
| ---------------- | :-: | :----: | :----: | :----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seam manifests   |  B  |   A    | 💎💎💎 |   🔴   | `fork:scan` catches undeclared shared files, but the scan tables are prose with no anchors, widths, or budgets. Converting them to authoritative manifests is the biggest single lever and touches every domain. |
| Retirement watch | B−  |   A−   |  💎💎  |   🟡   | Retire conditions are prose a human walks each rebase. Machine-watch `retire-when` rules through the existing upstream watch.                                                                                    |
| Typed gates      | B+  |   A    |   💎   |   🟡   | Gated skills exist but verdicts are partly prose. Type them, and pin the four human decision points explicitly.                                                                                                  |

## Wave 4 — heavy lifts

| Dimension   | Now | Target | Value | Effort | Gap                                                                                                                                             |
| ----------- | :-: | :----: | :---: | :----: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Plane split |  C  |   A    | 💎💎  |   🔴   | fork-meta is 64 of 158 stack commits. Moving tooling and runbooks to a forge repository takes them out of the replayed range.                   |
| Forge reuse |  C  |   A−   |  💎   |   🔴   | `scripts/fork-*.ts` are welded to this repository. Only worth extracting together with the plane split.                                         |
| Tag lattice |  B  |   A−   |  💎   |   🔴   | The feasibility scan evaluates one newest clean tag; the target is a verdict per tag. CI-expensive, and the current scan is adequate meanwhile. |

## Continuous

**Seam reshaping** — 💎💎💎 🔴, never a wave. 278 of the delta's 477 files sit in upstream's 90-day
churn path. That number only shrinks through case-by-case reshaping (retire, or move logic into
fork-only paths behind a narrow hook), prioritized by the wave-2 pressure report.

## Already at target

Candidate/promote/release machinery (A−): `hyprws-next`, `hyprws-previous`, leased promotion,
candidate mode. Keep as is.

## Snapshot — 2026-08-31

Measured over `merge-base(hyprws, main)..hyprws`, upstream churn window 90 days:

| Fact                               |                                                     Value |
| ---------------------------------- | --------------------------------------------------------: |
| Stack commits                      |                                                       158 |
| Delta                              |                               477 files, +51,999 / −1,998 |
| Fork-only (added) files            |                                                       196 |
| Modified upstream files            |                                                       281 |
| Delta files in upstream churn path |                                                 278 (58%) |
| fork-meta commits                  |       64 (18% seam ratio — the cheapest 40% of the stack) |
| Highest seam-ratio domains         | worktrunk-hooks 87%, thread-ordering 81%, zmux-estate 82% |
