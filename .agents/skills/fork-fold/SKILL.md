---
name: fork-fold
description: Fold the RSI-Software/t3code-hyprws ahead commits to one intent each: list the stack, write a plan, replay it onto a detached tip, prove it, push with the lease. Use on demand after a sync or landing leaves fix-of-fix noise on hyprws.
---

# Fork fold

Keep each ahead commit one intent, so a rebase conflict is solved once.
The agent picks the folds; `scripts/fork-fold.ts` only lists, applies, and proves.

## Scope

| Noise                        | Owner                                  |
| ---------------------------- | -------------------------------------- |
| A `fixup! <subject>` landing | `fork:sync`, folded at the next rebase |
| Ordinary commits, now landed | This skill                             |

## Run

From a checkout with `origin/hyprws` and `upstream/main` fetched:

```bash
vp run fork:fold list --head origin/hyprws
vp run fork:fold apply plan.tsv --head origin/hyprws
vp run fork:fold prove origin/hyprws <tip>
```

1. **List:** domains, files, stack positions
2. **Plan:** per the [fold rule](#fold-rule)
3. **Apply:** prints `<tip>`; moves no ref
4. **Prove:** exit 0, or no push
5. **Push:** the [expected-old lease][lease]
6. **Reset:** [local trunks][trunk]

[lease]: ../../../docs/fork/operations/fork-sync.md#model
[trunk]: ../../../docs/fork/operations/fork-sync.md#local-trunk

For JSON, run `node scripts/fork-fold.ts list --json`; `vp run` prints a banner first.

## Plan

One line per output commit: member shas, tab-separated, in stack order.

```text
# a comment
9e2656daeb	4f7a0802b5	fix(fork): optional subject override
25bf181b2a
```

- **Coverage:** every ahead commit, exactly once
- **Order:** line order is the new stack order
- **One member:** message kept verbatim
- **Fold:** lead prose, `Squashes:`, merged trailers

## Fold rule

Fold when both hold:

- **Intent:** one
- **Domain:** the same `Fork-Domain`

Never fold:

- **Across domains:** the ledger loses one
- **Repairs:** a `Fork-Repair` commit
- **Lockfiles:** a lockfile bump
- **Open pull requests:** any member of one

## Stops

| Output                                | Move                           |
| ------------------------------------- | ------------------------------ |
| `does not apply at its plan position` | Reorder or split that line     |
| `plan does not cover the stack`       | Fix the listed shas            |
| `prove` exit 1                        | Read the failed check; no push |

## Cadence

On demand, after a sync or landing leaves fix-of-fix noise.
