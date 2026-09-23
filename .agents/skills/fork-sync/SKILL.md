---
name: fork-sync
description: Sync RSI-Software/t3code-hyprws with upstream: pick a release tag, run the one sync driver, read its typed report, and unblock a stopped rebase by hand.
---

# Fork sync

One driver walks one upstream release tag end to end: fetch, rebase, check, push, blocked, report.
A run has one exit code and one typed report.
No modes, no gates, no lanes: a rerun of the same command is always the next move.

## Run

```bash
vp run fork:sync            # newest upstream release tag
vp run fork:sync <tag>      # one named v… tag
vp run fork:sync <tag> --dry-run
```

`--dry-run` rebases and checks, then stops: no push, no issue, no publication.
Any other flag is a defect.

## Read the report

`.t3/fork-sync/<tag>.json` is the only run authority; the printed Markdown is output.
Post-push recovery reads this file, never a comment.

| Field         | Meaning                                                    |
| ------------- | ---------------------------------------------------------- |
| `outcome`     | `applied`, `already-applied`, `blocked`, or `failed`       |
| `target`      | The tag and its sha                                        |
| `lease`       | The `origin/hyprws` sha the push is leased against         |
| `trunk`       | Trunk before and after the run                             |
| `conflicts[]` | Path, fork commit, upstream commit, resolution route       |
| `checks[]`    | `fork:delta --check`, `fork:scan`, typecheck, and results  |
| `decision`    | A blocked run's worktree, paths, and exact resume commands |

Never edit a report; a rerun supersedes it.

## Stops

| Report                          | Stop                            |
| ------------------------------- | ------------------------------- |
| `failed` at `fetch` or `target` | [Environment](#environment)     |
| `blocked` with `manual` rows    | [Conflict](#conflict)           |
| `failed` at `check`             | [Check battery](#check-battery) |
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
| Reshape | Fork side moved too; narrow the seam, land `fixup!`         |
| Retire  | Upstream owns it now; traced verdict, drop at rebase        |

### Check battery

The battery is red.

- **Fix**: by pull request
- **Never**: weaken a check

### Lease refusal

The expected-old lease lost; someone landed first.

- **Inspect**: the trunk
- **Rerun**: never `--force`

## Unblock

The driver resolves every seam it can: local rerere replays resolutions within the run's rebase, and hook re-apply re-inserts marked fork hooks.
Only a `manual` row stops the run.

Only upstream moved: upstream's text stands.
A marked fork hook goes back verbatim.
Upstream deleted and the fork edit is net-zero: the deletion stands.

1. Read `decision`: worktree, paths, resume commands.
2. Open that worktree.
3. Resolve each path by the rule above.
4. `git add` the resolved paths.
5. `git rebase --continue`.
6. Rerun `vp run fork:sync <tag>`.

Rerere replays the resolution within the rerun's rebase; the run completes.

A blocked run files one block issue (label `ci`) keyed by the blocking upstream sha.
A rerun on the same sha updates that issue; a clean run closes it.

A failed run files one failure issue the same way, keyed by the failing step and the target tag (the trunk sha before a tag resolves).
A rerun with the same failure updates it; a clean run closes it.

## Never

- **Post** to `pingdotgg/t3code`
- **Merge** upstream into `hyprws`
- **Move** published tags
- **Force** past a refused lease: inspect, rerun
- **Edit** a report; a comment decides nothing
