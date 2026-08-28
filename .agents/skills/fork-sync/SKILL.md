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

## Gate 1 — Orient

One command orients the whole gate. The preflight it runs fetches upstream tags, so list the
candidates after it and orient against the one you pick. The `hyprws` worktree does not need to be
clean; orientation reads `origin/hyprws`.

```bash
vp run fork:preflight
git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 3
node scripts/fork-orient.ts --target "$tag"
```

`node` is deliberate: Gate 1 runs in a worktree with no dependencies installed, and `vp run
fork:orient` is the same command once `vp i` has run. Orientation proves the tag exists as a tag and
is reachable from `upstream/main`; a version-shaped name is refused. It prints target, source, shared
base, mirror currency, feasibility, automerged overlap, retire candidates, and an `upstream-watch`
verdict per open issue against that tag.

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
at the current seam. Never skip, squash, reorder, or reword a fork commit. Classify every conflicted
file as `mechanical`, `seam-moved`, `retire-candidate`, or `human`; review rerere output as a new
resolution. Start the record immediately and retain every `Fork-*` trailer.

**Stop.** Show the human the rebased head, stack size, conflict counts by class, all
`retire-candidate`/`human` rows, and any unresolved block. Continue only when the rebase is complete
and the conflicts table has one row per (fork commit, file).

## Gate 3 — Check

Walk every involved domain's rebase scan, including automerged overlap. Then run only focused checks:

```bash
vp run fork:delta --check
vp run --filter <touched-package> typecheck
vp test run <tests-beside-every-touched-file>
```

Record exact commands and results. The commit table must have one row for every rehearsed fork
commit, keyed by its exact subject. Record typecheck-only findings under **Silent seams**. Every
product claim must name the exact UI label and expected outcome; a thread-sync claim must use a sent
message, never a draft.

**Stop.** Show the human failed checks, silent seams, and the complete draft record. Continue only
when `fork:delta`, every targeted typecheck, and every adjacent test pass. Do not substitute repo-wide
checks.

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
git add "docs/operations/fork-sync-records/$tag.md" docs/internals/fork-delta.md
git commit -m "docs(fork): record $tag rehearsal" \
  -m $'Fork-Domain: fork-meta\nFork-Tier: qol'
vp run fork:delta --check
```

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
human, who alone performs the published-head rewrite, tag, and release:

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
