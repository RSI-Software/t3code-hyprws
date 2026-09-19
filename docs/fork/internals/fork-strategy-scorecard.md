# Fork strategy scorecard

> Today's system against the [fork strategy](./fork-strategy.md) target, ordered as a migration.
> Regrade when the gap moves.

**Legend** · A-F · 💎💎💎 major / 💎💎 solid / 💎 nice · 🟢 easy / 🟡 moderate / 🔴 heavy

Waves are independent and unhurried.

## Wave 1: quick wins

| Dimension           | Now | Target | Value  | Effort | Gap                                        |
| ------------------- | :-: | :----: | :----: | :----: | ------------------------------------------ |
| Regenerable files   |  A  |   A    | 💎💎💎 |   🟢   | at target: re-derived, never merged        |
| Operational records |  A  |   A    |  💎💎  |   🟢   | at target: gate refuses an in-repo record  |
| Release provenance  |  A  |   A    |   💎   |   🟢   | at target: bodies stamp `Delta revision:`  |
| Granularity policy  | A−  |   A−   |   💎   |   🟢   | at target: stated in the development guide |

## Wave 2: instruments

| Dimension             | Now | Target | Value  | Effort | Gap                                      |
| --------------------- | :-: | :----: | :----: | :----: | ---------------------------------------- |
| Seam-pressure metrics |  D  |   A    | 💎💎💎 |   🟡   | none exist; structural calls run on feel |
| Delta-log             |  B  |   A    |  💎💎  |   🟡   | rebase erases delta identity             |

## Wave 3: machine contracts

| Dimension        | Now | Target | Value  | Effort | Gap                                            |
| ---------------- | :-: | :----: | :----: | :----: | ---------------------------------------------- |
| Seam manifests   |  B  |   A    | 💎💎💎 |   🔴   | scan tables lack anchors, widths, budgets      |
| Retirement watch | B−  |   A−   |  💎💎  |   🟡   | retire conditions are prose a human walks      |
| Typed gates      | B+  |   A    |   💎   |   🟡   | verdicts partly prose; pin the human decisions |

## Wave 4: heavy lifts

| Dimension   | Now | Target | Value | Effort | Gap                                           |
| ----------- | :-: | :----: | :---: | :----: | --------------------------------------------- |
| Plane split |  C  |   A    | 💎💎  |   🔴   | tooling still inside the replayed range       |
| Forge reuse |  C  |   A−   |  💎   |   🔴   | `scripts/fork-*.ts` welded to this repository |
| Tag lattice |  B  |   A−   |  💎   |   🔴   | one clean tag, not a verdict per tag          |

## Continuous

**Seam reshaping:** 💎💎💎 🔴, never a wave.
Most of the delta sits in upstream's churn path.
It shrinks only case by case: retire, or hide logic behind a narrow hook.

**Candidate machinery:** A−, at target, keep as is.
