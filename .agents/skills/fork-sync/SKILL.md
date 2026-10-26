---
name: fork-sync
description: Sync RSI-Software/t3code-hyprws with upstream: pick a release tag, run the one sync driver, read its typed report, and unblock a stopped rebase by hand.
---

# Fork sync

One driver walks one upstream release tag end to end: fetch, rebase, ci, push, blocked, report.
The trunk moves only to a sha `hyprws CI` passed on the `sync/candidate` branch.
A run has one exit code and one typed report.
No modes, no gates, no lanes: a rerun of the same command is always the next move.

## Run

```bash
vp run fork:sync            # newest upstream release tag
vp run fork:sync <tag>      # one named v… tag
vp run fork:sync <tag> --dry-run
```

`--dry-run` rebases and runs candidate CI, then stops: no trunk push, no issue, no publication.
The run waits for the checkout's own worktree setup first.
Any other flag is a defect.
Name a tag only when the user names one; otherwise run with no tag.

A green dry run keeps its tip in the sync worktree for the real run:

1. Dry run reaches `applied`
2. `decision.tip` names the kept tip
3. `vp run fork:sync <tag>` adopts it
4. Its green run is reused; the tip pushes

A moved lease or a new tag rebases again instead.

## Read the report

`.t3/fork-sync/<tag>.json` in the main checkout is the only run authority; the printed Markdown is output.
The kept sync worktree lives there too, whichever checkout runs the sync.
Post-push recovery reads this file, never a comment.

Fields: [the report](../../../docs/fork/operations/fork-sync.md#the-report).
`decision.tip` names a kept tip: a red candidate or a green dry run.

Never edit a report; a rerun supersedes it.

## Stops

| Report                          | Stop                            |
| ------------------------------- | ------------------------------- |
| `failed` at `fetch` or `target` | [Environment](#environment)     |
| `blocked` with `manual` rows    | [Conflict](#conflict)           |
| `failed` at `ci`                | [Candidate CI](#candidate-ci)   |
| `failed` at `push`              | [Lease refusal](#lease-refusal) |

### Environment

The run never rebased; the stack is untouched.

- **Fix**: the remote or the tag
- **Rerun**: the same command

### Conflict

A seam neither rerere nor hook re-apply resolves.
Resolve each seam by verdict, then follow Unblock.

| Verdict | Seam                                                        |
| ------- | ----------------------------------------------------------- |
| Keep    | Only upstream moved; upstream stands, hook returns verbatim |
| Reshape | Fork side moved too; resolve minimally, adapt at the tip    |
| Retire  | Upstream owns it now; its own commit, never inside a fixup  |

### Candidate CI

`hyprws CI` is not green on the candidate; the worktree keeps the tip.

- **Local gate**: `fork:ci` red; nothing pushed
- **Red job**: `ci.jobs` names it
- **Wait**: ends at the first failed job
- **Real failure**: fix in the kept worktree
- **Tests**: `vp test run` inside the package
- **Fixup owner**: `vp run fork:fixup-fold`
- **Flake**: `gh run rerun` after the run ends
- **Never started**: check the mirror token
- **Rerun**: the same command
- **Never**: weaken a check

### Lease refusal

The expected-old lease lost; someone landed first.

- **Rerun**: it rebases the new trunk
- **Carry**: automatic; tip commits cherry-pick
- **Never**: `--force`

## Unblock

The driver resolves every seam it can: rerere replays resolutions from this rebase and [`sync/resolution`](#job-mode), and hook re-apply re-inserts marked fork hooks.
Only a `manual` row stops the run.

In the rebase, resolve minimally: upstream's text stands, and a marked fork hook goes back verbatim.
Upstream deleted and the fork edit is net-zero: the deletion stands.
Before keeping an upstream deletion, grep the old trunk (`git grep <name> <lease sha>`): later fork commits are not replayed yet.
A [regenerable file](../../../docs/fork/operations/fork-sync.md#regenerable-files) regenerates on the rerun.
Never adapt inside a replayed commit: the hook guard refuses it.
Adaptation lands at the tip, one commit per owner, per [Reshape](../../../docs/fork/operations/fork-sync.md#unblocking-by-hand).
The owner is the newest fork commit touching those lines; `fork:fixup-fold` names it.
A fixup that edits an unmarked fork line marks it.

**Second block:** the same seam stops a second sync.

- **Cause:** the owner is not a pure insertion
- **Fix:** reshape it in a tip `fixup!`
- **Shape:** [marked insertions only][hook]
- **Next sync:** may stop once more, then folds it
- **Sooner:** fold it now with [fork-fold][fold]

[hook]: ../../../docs/fork/internals/fork-delta.md#marking-a-hook
[fold]: ../fork-fold/SKILL.md

1. Read `decision`: worktree, paths, resume commands.
2. Open that worktree.
3. Resolve each path by the rule above.
4. `git add` them.
5. Rerun `vp run fork:sync <tag>`.

Never `git rebase --continue` or script a resolver: the rerun continues the rebase with every automatic resolver, and the report keeps only stops a run saw.
Adaptation the candidate needs surfaces as a `ci` failure; commit it at the tip, then rerun.
Watch the run's output live; candidate CI can take most of an hour.
The worktree ran the `t3.json` setup step, so it builds and tests.
A new tag or a moved lease recreates the worktree and carries its tip commits.
A carried commit that conflicts stops like a rebase seam: resolve, `git add`, rerun.

Every blocked or failed run rewrites one standing sync attention issue (label `ci`).
The newest open issue of either legacy title (`hyprws sync blocked` or `hyprws sync failed`) is adopted; surplus issues close with a pointer to it.
Only no match files a new issue.
The body keeps its open-since date, target count, and last five runs; a clean run closes it.

### Finished tip from elsewhere

1. Open the kept worktree.
2. `git rebase --abort` if one is in progress.
3. `git reset --hard <sha>`.
4. Rerun `vp run fork:sync <tag>`.

## Job mode

A job resolves a blocked sync without writing the trunk or the candidate.
It hands its resolutions to the next run as data on `sync/resolution`.
No human reviews it: candidate CI gates the landing.

1. Add the `upstream` remote unless present
2. Put `vp` on PATH, outside `node_modules`
3. Run `vp run fork:sync <tag> --dry-run`
4. Resolve `manual` paths per [Conflict](#conflict)
5. `git add` them in the kept worktree; rerun
6. Repeat until the rebase finishes
7. Commit tip adaptation there; rerun once
8. `git update-ref --no-deref HEAD refs/fork-sync/resolution`
9. Report `committed`: rsi-pr-agent pushes `HEAD`; the sync reruns

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
mkdir -p /tmp/fork-bin && ln -sf "$PWD/node_modules/.bin/vp" /tmp/fork-bin/vp
PATH=/tmp/fork-bin:$PATH vp run fork:sync <tag> --dry-run
```

**Decide every seam.** Uncertainty never blocks a job:

- **Default:** upstream stands; port at the tip
- **Port fails its checks:** Retire it
- **Each Reshape or Retire:** one Verify item
- **Blocked:** only a driver or setup failure

The report's summary ends with `Verify:` and those items: behaviour to exercise once the sync lands.

Every rebase rewrites `refs/fork-sync/resolution` before `ci`, so a `ci` failure in the job is expected.
It is one parentless commit:

```text
rr-cache/<id>/preimage   one per resolved stop
rr-cache/<id>/postimage
fixups.mbox              tip commits above the rebase
```

The next run imports it before it rebases: rerere replays each stop, and the fixups apply when its `Fork-Sync-Tag` matches.
Anything else on the branch fails the run.

## Never

- **Post** to `pingdotgg/t3code`
- **Merge** upstream into `hyprws`
- **Move** published tags
- **Force** past a refused lease: inspect, rerun
- **Edit** a report; a comment decides nothing
