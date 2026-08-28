---
name: fork-sync
description: Guide the RSI-Software/t3code-hyprws fork through a stable upstream-tag rebase rehearsal, focused checks, human sanity review, and a human-only leased apply.
---

# Fork sync

Use this single flow for every upstream rebase. It has five gates and a hard stop at each one.
Never target a nightly or untagged commit. Never post to `pingdotgg/t3code`. Never rebase, push,
tag, or release from the `hyprws` worktree while running the agent-owned gates.

Set `tag=vX.Y.Z` to the chosen stable tag. The record is
`docs/operations/fork-sync-records/$tag.md`; follow [the record schema](references/record.md) and
[the rehearsal procedure](references/rehearse.md).

Every command a gate runs is written here or in those two references, and nowhere else. The
[fork-sync runbook](../../../docs/operations/fork-sync.md) owns the invariants each gate enforces, what
the orientation output means, failure handling, and the one-time repository setup; it carries no gate
command.

## Gate 1 — Orient

The preflight fetches both lanes and proves the `main` mirror is current, so run it first. Sweep the
watches against `upstream/main` before you pick, because a watch that is still `waiting` there can
change which tag is worth taking. Then list the candidates and orient against the one you pick.

```bash
node scripts/fork-preflight.ts
node scripts/fork-upstream-watch.ts
git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 3
node scripts/fork-orient.ts --target "$tag"
```

`node` is deliberate: Gate 1 runs in a worktree with no dependencies installed, and `vp run
fork:preflight`, `vp run fork:upstream-watch`, and `vp run fork:orient` are the same commands once
`vp i` has run. Orientation re-runs the preflight itself and refuses on an unmet precondition, so the
first line is the one that names every unmet one before anything else runs. The `hyprws` worktree does
not need to be clean; orientation reads `origin/hyprws`.

Orientation proves the tag exists as a tag and is reachable from `upstream/main`; a version-shaped
name is refused. It prints target, source, shared base, mirror currency, feasibility, automerged
overlap, retire candidates, and an `upstream-watch` verdict per open issue against that tag. That
tag-targeted sweep is the one Gate 5 closes from; the pre-pick sweep above only informs the pick.
The runbook explains [what each verdict
means](../../../docs/operations/fork-sync.md#what-the-orientation-means).

**Stop.** Show the human the Stop block the command printed. Continue only after the human confirms
the target. The orientation is not permission to modify a ref.

## Gate 2 — Rehearse

Create a disposable lane from the published fork; do not rebase the current checkout:

```bash
wt switch --create "rehearse/$tag" --base origin/hyprws
# Continue in the worktree path printed by Worktrunk.
vp i
expected_old=$(git rev-parse origin/hyprws)
target_sha=$(git rev-parse "$tag^{commit}")
git rebase "$tag"
```

At every stop, read upstream intent first and preserve it, then reapply the smallest fork behavior
at the current seam. Never squash, reorder, or reword a fork commit, and never run `git rebase
--skip`: a commit upstream has made obsolete is a `retire-candidate` row for the human at Gate 4, not
a commit the rehearsal drops on its own. Classify every conflicted file as `mechanical`,
`seam-moved`, `retire-candidate`, or `human`; review rerere output as a new resolution. Start the
record immediately and retain every `Fork-*` trailer.

**Stop.** Show the human the rebased head, stack size, conflict counts by class, all
`retire-candidate`/`human` rows, and any unresolved block. Continue only when the rebase is complete
and every conflicted (fork commit, file) has a row, or the rebase stopped zero times and the record
says `None.` with its replay evidence.

## Gate 3 — Check

Walk every involved domain's rebase scan, including automerged overlap. Then run only focused checks:

```bash
vp run fork:delta --check
vp run --filter <touched-package> typecheck
vp test run <tests-beside-every-touched-file>
```

Record exact commands and results. The commit table carries one row per decision, claim, or change,
keyed by its exact subject; the record schema owns which commits require a row. Review every file
the orientation report predicted as automerged overlap, because no rebase stop will raise one.
Record typecheck-only findings under **Silent seams**. Every
product claim must name the exact UI label and expected outcome; a thread-sync claim must use a sent
message, never a draft.

**Stop.** Show the human failed checks, silent seams, and the complete draft record. Continue only
when `fork:delta`, every targeted typecheck, and every adjacent test pass. Never substitute a
repo-wide `vp check`, `vp run -r typecheck`, or `vp run -r test` for the targeted set: fork CI owns
the full suite, and a repo-wide run hides which seam failed.

## Gate 4 — Human sanity

The human reads only the decision rows and grounding claims:

```bash
rg '\| (retire-candidate|human) \|' "docs/operations/fork-sync-records/$tag.md"
rg 'Grounding (claim|pending)' "docs/operations/fork-sync-records/$tag.md"
```

The human resolves each decision by exact fork commit subject in the `Retired` or `Kept` section of
`docs/internals/fork-delta.md`, completes every required desktop grounding claim, and replaces the
record's absent marker with `Human sanity: <login> YYYY-MM-DD`. The agent must not perform or infer
this approval.

Commit the completed record and durable decisions on the rehearsal branch:

```bash
vp run fork:upstream-refs "docs/operations/fork-sync-records/$tag.md"
git add "docs/operations/fork-sync-records/$tag.md" docs/internals/fork-delta.md
git commit -m "docs(fork): record $tag rehearsal" \
  -m $'Fork-Domain: fork-meta\nFork-Tier: qol'
vp run fork:delta --check
```

The guard runs first because a squash subject carries `(#<number>)`, which posts a backlink upstream
once the record is published. `fork:delta --check` counts the record commit, so it reports one more
than the record's `Stack size`.

**Stop.** Show the human the sanity login/date, resolved retire/keep subjects, grounding evidence,
record commit, and green checks. Continue only with a committed record and explicit human approval.

## Gate 5 — Apply

First run the deterministic guard from the rehearsed branch:

```bash
vp run fork:sync-gate --tag "$tag"
```

It refuses on any unmet preflight precondition, and reads the published head from the fetch it just
made. An unmet precondition, a missing record, a stale `expected_old`, or a missing sanity mark
blocks apply. If `origin/hyprws`
moved, fetch it, read the new commits, incorporate them through the drift procedure in
[the rehearsal reference](references/rehearse.md), update the record, and repeat gates 3–4.

**Stop.** The skill and agent never run the commands below. Print their resolved values for the
human, who alone performs the published-head rewrite, tag, and release. `$release_tag` follows the
[fork release naming
rule](../../../docs/operations/fork-sync.md#invariants):

```bash
git push --force-with-lease=refs/heads/hyprws:"$expected_old" origin HEAD:hyprws
git tag "$release_tag" HEAD
git push origin "$release_tag"
gh run list --repo RSI-Software/t3code-hyprws --workflow hyprws-release.yml --limit 1
gh run watch <run-id> --repo RSI-Software/t3code-hyprws
gh release view "$release_tag" --repo RSI-Software/t3code-hyprws
```

The human verifies the release has the `.AppImage` and `latest-linux.yml` assets and that the
record's retire/keep ledger entries are present. A refused lease returns to rehearsal; it is never
silently refreshed.

Then the human installs or runs that build and closes each `upstream-watch` issue Gate 1's
tag-targeted sweep called `ready`, naming the upstream merge commit and this fork release. This is
the only place a watch closes, and only that sweep names the candidates. A watch whose behavior is
still broken stays open with what was seen.
