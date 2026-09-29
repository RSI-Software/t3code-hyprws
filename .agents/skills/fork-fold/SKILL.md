---
name: fork-fold
description: Fold the RSI-Software/t3code-hyprws ahead commits to one PR-sized intent each: list the stack, write a plan, replay it, prove it, publish with the lease. Use on demand after a sync or landing leaves fix-of-fix noise on hyprws.
---

# Fork fold

Keep each ahead commit one PR-sized intent, so a rebase conflict is solved once.
The agent picks the folds; `scripts/fork-fold.ts` only lists, applies, and publishes.

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
vp run fork:fold publish origin/hyprws <tip>
```

1. **List:** domains, files, stack positions
2. **Plan:** per the [fold rule](#fold-rule)
3. **Apply:** prints `<tip>`; moves no ref. The fast path replays with merge-tree; from the first refused block the remaining plan finishes as one autosquashed rebase in a worktree under the git common dir, kept until the fold finishes; at each stop the agent resolves and reruns the same apply command
4. **Publish:** refuses unless local hyprws sits at `<old>` and the worktree where hyprws is checked out is clean; proves, then pushes with the [expected-old lease][lease] and moves the [local trunks][trunk]; a failed proof pushes nothing

A fold is tree-equal but rewrites commit boundaries: the release delta revision changes, and a nightly may republish the same tree.

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
- **Fold:** lead prose, `Squashes:` with each member's PR references, merged trailers

## Fold rule

One PR-sized intent per output commit: a feature absorbs its fixes and resolutions.

Fold when both hold:

- **Intent:** one
- **Domain:** the same `Fork-Domain`

The plan refuses a mixed-domain line: across domains the ledger would lose one.

## Stops

| Output                                | Move                            |
| ------------------------------------- | ------------------------------- |
| `does not apply at its plan position` | Reorder or split that line      |
| `plan does not cover the stack`       | Fix the listed shas             |
| `publish` refuses                     | Read the reason; nothing pushed |

## Cadence

On demand, after a sync or landing leaves fix-of-fix noise.
