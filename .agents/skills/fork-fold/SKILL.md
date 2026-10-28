---
name: fork-fold
description: Fold the RSI-Software/t3code-hyprws ahead commits to one PR-sized intent each: list the stack, write a plan, replay it, prove it, hand it off through the fork-sync marker. Use inside a fork-sync session after a green run, or when fork-sync points here.
---

# Fork fold

Keep each ahead commit one PR-sized intent, so a seam conflicts once per replay, not once per commit.
The agent picks the folds; `scripts/fork-fold.ts` only lists, applies, and proves.
It never writes `hyprws`: the fold lands through the [fork-sync](../fork-sync/SKILL.md) marker, so the land run stays the only trunk writer.

## Scope

| Noise                                    | Owner                                  |
| ---------------------------------------- | -------------------------------------- |
| A `fixup! <subject>` landing or sync tip | `fork:sync`, folded at the next rebase |
| Ordinary commits, now landed             | This skill                             |

## Run

In the fork-sync kept worktree, after a green `vp run fork:sync <tag>`:

```bash
vp run fork:fold list --base <tag> --head HEAD
vp run fork:fold apply ../fold.tsv --base <tag> --head HEAD
vp run fork:fold prove --base <tag> HEAD <tip>
git checkout --detach <tip>
```

1. **List:** domains, files, stack positions
2. **Plan:** `../fold.tsv`; [fold rule](#fold-rule)
3. **Apply:** prints `<tip>`; moves no ref
4. **Prove:** `<old>` is the unfolded `HEAD`
5. **Move:** detach the kept worktree at `<tip>`
6. **Rerun** the sync, then [hand off][handoff]

[handoff]: ../fork-sync/SKILL.md#hand-off

`apply` replays with merge-tree; from the first refused block the rest of the plan finishes as one autosquashed rebase in a worktree under the git common dir.
At each stop, resolve there and rerun the same apply command.
The fold is tree-equal, so the move changes nothing on disk.
The land run gates the folded tip like any sync tip: candidate CI, then the [expected-old lease][lease].
An apply stop or failed proof moves nothing: hand off the unfolded marker.

A conflict on a path the stack base lacks is fork-owned: `apply` resolves it to the old head, or drops it when the head lacks it.
Only upstream-owned conflicts stop, since only they recur on a rebase.
A middle commit may then hold a fork-owned file's final form early; only the tip is tested.

A fold is tree-equal but rewrites commit boundaries: the release delta revision changes, and a nightly may republish the same tree.

[lease]: ../../../docs/fork/operations/fork-sync.md#model

For JSON, run `node scripts/fork-fold.ts list --json`; `vp run` prints a banner first.

## Plan

One line per output commit: member shas, tab-separated, in stack order.

```text
# a comment
9e2656daeb	4f7a0802b5	fix(fork): optional subject override
25bf181b2a	RSI-Software/t3code-hyprws#395
```

- **Coverage:** every ahead commit, exactly once
- **Order:** line order is the new stack order
- **One member:** message kept verbatim
- **Fold:** lead prose, merged trailers
- **`Squashes:`** each member's PR references

A `RSI-Software/t3code-hyprws#N` field attaches that PR link to the lead's `Squashes:` line; a lone member then renders as a fold.
Backfill a link an earlier fold lost this way.

## Fold rule

One PR-sized intent per output commit: a feature absorbs its fixes and resolutions.

Fold by [owning intent or cancellation](../../../docs/fork/internals/fork-development.md#fold-to-stay-tight), never by domain alone.
The plan refuses a mixed-domain line: across domains the ledger would lose one.

## Prove

A tree-equal fold needs no retest.
`prove` also refuses:

| Commit | Refused when                              |
| ------ | ----------------------------------------- |
| Any    | it drops a PR link                        |
| New    | it cites a sha `<old>` never names        |
| New    | it names no `<old>` member                |
| New    | it touches a path no member touched       |
| Old    | no new commit owns it                     |
| Old    | it splits and some owner does not cite it |

## Stops

| Output                                | Move                               |
| ------------------------------------- | ---------------------------------- |
| `does not apply at its plan position` | Reorder or split that line         |
| `plan does not cover the stack`       | Fix the listed shas                |
| `prove` fails                         | Fix the plan, or hand off unfolded |

## Cadence

Every sync session with budget left after a green run.
A partial plan is fine: single-member lines keep their commits, so each sync tightens the stack further.
