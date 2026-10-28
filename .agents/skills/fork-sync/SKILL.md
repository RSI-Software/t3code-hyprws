---
name: fork-sync
description: Sync RSI-Software/t3code-hyprws with upstream: rebase onto a release tag, resolve its seams by hand, and hand the tip to the land run through the sync/resolution marker. One procedure for a human session and the rsi-pr-agent job.
---

# Fork sync

A human session and an rsi-pr-agent job follow one procedure; only the [hand-off](#hand-off) differs.
A session rebases; the `hyprws upstream sync` workflow lands.
The trunk moves only to a sha `hyprws CI` passed on `sync/candidate`.
A rerun of the same command is always the next move.

## Run

```bash
vp run fork:sync            # target picked below
vp run fork:sync <tag>      # one named v… tag
```

- **Session:** rebases only; no CI, push, or issue
- **Tag:** name one only when the user does
- **Setup:** waits for the checkout's own setup
- **`--land`:** workflow only; never a session

Any other flag is a defect.

**Target:** the named tag, else the kept worktree's or a valid marker's tag the trunk lacks, else the newest upstream release tag.

**Start:** the first that applies.

1. Kept worktree: same tag and target, live lease
2. A valid [marker](#hand-off)'s tip
3. Fresh: `origin/hyprws` rebased onto the tag

A lease is live while `origin/hyprws` contains it.
A partial marker resumes its saved rebase todo.

A moved trunk keeps the lease: the run carries the new trunk commits at the end.
To drop the kept worktree and adopt a marker or start fresh, delete `.t3/fork-sync/worktree.json` in the main checkout and rerun.

## Read the report

`.t3/fork-sync/<tag>.json` in the main checkout is the only run authority; the printed Markdown is output.
The kept worktree lives beside it, whichever checkout runs the sync.
Fields: [the report](../../../docs/fork/operations/fork-sync.md#the-report).
Never edit a report; a rerun supersedes it.

| Outcome           | Exit | Next                                              |
| ----------------- | ---- | ------------------------------------------------- |
| `already-applied` | 0    | nothing                                           |
| `rebased`         | 0    | [tip work](#tip-work), then [hand off](#hand-off) |
| `blocked`         | 1    | [resolve](#resolve) the seams                     |
| `failed` `carry`  | 1    | [resolve](#resolve) the pick                      |
| `failed` `hooks`  | 1    | restore or retire each; rerun                     |
| `failed` `check`  | 1    | fix it as [tip work](#tip-work), rerun            |
| `failed` other    | 1    | fix the remote, tag, or `error`; rerun            |

## Procedure

1. Run `vp run fork:sync [<tag>]`
2. Stopped: [resolve](#resolve), then rerun
3. `rebased`: commit [tip work](#tip-work), rerun
4. Green, with budget left: [fold](#fold), rerun
5. [Hand off](#hand-off) the marker

Never `git rebase --continue`, `git cherry-pick --continue`, or script a resolver.
The rerun continues with every automatic resolver, and the report keeps only stops a run saw.

## Resolve

`decision` names the worktree, the paths, and the resume commands.
Resolve each path in that worktree by verdict, then `git add` it.

| Verdict | Seam                 | Resolve                 |
| ------- | -------------------- | ----------------------- |
| Keep    | Only upstream moved  | upstream; hook verbatim |
| Reshape | Fork side moved too  | minimally; adapt at tip |
| Retire  | Upstream owns it now | `git rm`; own commit    |

**Resolve minimally:**

- **Upstream's text:** stands
- **Marked fork hook:** goes back verbatim
- **Net-zero fork edit:** upstream's delete stands
- **Replayed commit:** never adapt; hook guard
  - Adds no line its original lacked
  - A broken build is tip work, not resolution
- **[Regenerable][regen]:** regenerates on rerun

[regen]: ../../../docs/fork/operations/fork-sync.md#regenerable-files

Before keeping an upstream deletion, grep the old trunk (`git grep <name> <lease sha>`): later fork commits are not replayed yet.

A carried trunk commit conflicts like a seam: resolve, `git add`, rerun.

**Second block:** the same seam stops a second sync.

- **Cause:** the owner is not a pure insertion
- **Fix:** reshape it in a tip `fixup!`
- **Shape:** [marked insertions only][hook]
- **Next sync:** may stop once more, then folds it

[hook]: ../../../docs/fork/internals/fork-delta.md#marking-a-hook

To fold it sooner, [fold](#fold) this session.

## Tip work

Adaptation the candidate needs (build or test fixes, ports) commits at the tip of the kept worktree.

- **One commit per owner:** per [Reshape][reshape]
- **Iterate:** amend that owner's fixup
  - The guard reads each commit alone
  - A second fixup never clears the first
- **Comment-only line:** never in an upstream file
  - Move the code into a `.fork.ts` helper
- **Owner:** newest fork commit on those lines
- **Find it:** `vp run fork:fixup-fold`
- **Unmarked fork line:** the fixup marks it
- **Lost hook:** restore it at the tip
  - Target carries it: drop its leftovers
  - Trailer: `Fork-Hook-Retired: domain/name`
- **Merge-tree:** path conflicts with upstream
  - Move the hook lines off its changed lines
- **Local checks:** each rerun runs `fork:ci`
  - Focused tests: `vp test run`
- **Gate:** candidate CI in the land run

Run `vp test run` inside the package.
Rerun once after tip work so the marker covers it.

[reshape]: ../../../docs/fork/operations/fork-sync.md#reshape

## Fold

After a green run, fold the stack in the kept worktree per [fork-fold](../fork-fold/SKILL.md).
The fold is tree-equal, so the rerun that follows adopts it, and the marker hands it to the land run.
Skip it when the budget is short; the next sync folds further.

## Hand off

Every rerun writes `refs/fork-sync/resolution`: finished once the rebase ends, partial at every block.
A finished marker predates the `hooks` and `check` steps: hand it off after a green run, or red when the budget ends.
The land run refuses a red tip and keeps the marker; the next session or job resumes from it, partial or finished.

**Session:**

```bash
git push --force origin refs/fork-sync/resolution:refs/heads/sync/resolution
```

**Job:** point `HEAD` at the marker and report `committed`, with the tag's commit as the one prerequisite; rsi-pr-agent pushes `HEAD` to `sync/resolution`.

```bash
git update-ref --no-deref HEAD refs/fork-sync/resolution
git rev-parse '<tag>^{commit}'   # prerequisites: ["<sha>"]
```

The push runs `hyprws-sync-resolution.yml`, which dispatches the trunk's sync: [the land run](../../../docs/fork/operations/fork-sync.md#the-land-run).
A partial marker never lands; it rewrites the attention issue as blocked.

## Red candidate

The attention issue names each red job instead of a seam.

1. Run the session; it adopts the finished marker
2. Read each: `gh run view --job <id> --log-failed`
3. Reproduce with `vp test run` inside its package
4. Fix at the tip per [Tip work](#tip-work)
5. Rerun, then hand off

- **Flake:** `gh run rerun --failed`; rerun sync
- **Never started:** check the mirror token
- **Never:** weaken a check

## Job

The `rsi:fork-sync` label starts it on the attention issue.
No human reviews it: candidate CI gates the landing.

```sh
mkdir -p /tmp/fork-bin && ln -sf "$PWD/node_modules/.bin/vp" /tmp/fork-bin/vp
PATH=/tmp/fork-bin:$PATH vp run fork:sync <tag>
```

**Foreground only.** Run every command to completion; leave no background process before the reply.
A live one holds the job open and can rewrite the marker after the bundle.

**Decide every seam.** Uncertainty never blocks a job:

- **Default:** upstream stands; port at the tip
- **Port fails its checks:** Retire it
- **Each Reshape or Retire:** one Verify item
- **Blocked:** only a driver or setup failure

The summary ends with `Verify:` and those items: behaviour to exercise once the sync lands.

**Disk.** The job's disk holds one install, about 8 GiB.
The driver's kept worktree is the only other checkout; never clone, copy, add another, or run a second install.
The one exception: `fork:fold apply`'s own rebase worktree, which holds no install.

**Budget.** The job has 45 minutes, and a killed job saves nothing.

- **Clock:** `date -u` at start and at every stop
- **Fold:** start one only before 20 minutes gone
- **30 minutes gone:** rerun, hand off the marker
- **No progress:** same marker, so no new job

## Never

- **Post** to `pingdotgg/t3code`
- **Merge** upstream into `hyprws`
- **Push** `hyprws`: the land run writes it
- **Move** published tags
- **Force** past a refused lease: inspect, rerun
- **Edit** a report; a comment decides nothing
