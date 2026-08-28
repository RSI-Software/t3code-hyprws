---
name: fork-sync
description: Unblock an RSI-Software/t3code-hyprws upstream rebase with a gated rehearsal and leased apply, or cut a stable fork release from a bot-owned snapshot.
---

# Fork sync

Choose exactly one entry point:

- **unblock** — resolve the current `rebase-blocked` issue by rehearsing the complete fork stack on
  the selected upstream stable or nightly tag;
- **cut stable** — verify a bot-owned `release/vX.Y.Z-hyprws` snapshot and hand its immutable stable
  tag push to the human.

Never post to `pingdotgg/t3code`. Never merge upstream into `hyprws`. Never move
`hyprws-previous`, `hyprws-next`, or `release/vX.Y.Z-hyprws` by hand. The
[fork-sync runbook](../../../docs/operations/fork-sync.md) owns the bot model, ref meanings,
repository setup, failure handling, and local-lane recovery.

## Entry point: unblock

This flow has five gates and a hard stop at each one. The rewrite is rehearsed away from the
`hyprws` worktree, and the final push stays human-only with the expected-old lease captured by the
same rehearsal.

Set `tag` to the newest upstream release tag beyond the blocking commit that the human intends to
reach. Both `vX.Y.Z` and `vX.Y.Z-nightly.YYYYMMDD.<run>` are valid targets. The record is
`docs/operations/fork-sync-records/$tag.md`; follow [the record schema](references/record.md) and
[the rehearsal procedure](references/rehearse.md), treating `$tag` as the selected release tag when
it is a nightly.

### Gate 1 — Orient

The preflight fetches both lanes and proves the `main` mirror is current. Read the open block, sweep
upstream watches, list reachable release tags, and orient against the human's selection:

```bash
node scripts/fork-preflight.ts
repo=RSI-Software/t3code-hyprws
blocked_issue="$(gh issue list --state open --label rebase-blocked -R "$repo" \
  --json number --jq 'if length == 1 then .[0].number else error("expected one open rebase-blocked issue") end')"
gh issue view "$blocked_issue" --comments -R "$repo"
node scripts/fork-upstream-watch.ts
git tag --list 'v*' --sort=-v:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-nightly\.[0-9]{8}\.[0-9]+)?$' \
  | head -n 10
node scripts/fork-orient.ts --target "$tag"
```

`node` is deliberate: these scripts use Node builtins and can name preflight failures before `vp i`.
Orientation proves the target exists as a tag, is reachable from `upstream/main`, and reports
feasibility, automerged overlap, retire candidates, and `upstream-watch` verdicts. The selected tag
must be beyond the blocking upstream commit; choosing the last clean tag only reproduces the bot's
current result.

**Stop.** Show the human the issue's blocking SHA, target tag and SHA, source and shared base,
conflict/overlap summary, and watch verdicts. Record the full blocking SHA as `blocking_sha` for the
closing comment. Continue only after the human confirms the target. Orientation is not permission to
modify a ref.

### Gate 2 — Rehearse

Create a disposable lane from the published fork; never rebase the current checkout:

```bash
wt switch --create "rehearse/$tag" --base origin/hyprws
# Continue in the worktree path printed by Worktrunk.
vp i
expected_old="$(git rev-parse origin/hyprws)"
target_sha="$(git rev-parse "$tag^{commit}")"
git rebase "$tag"
```

At each stop, read upstream intent first, preserve it, and reapply the smallest fork behaviour at the
current seam. Never squash, reorder, reword, or `git rebase --skip` a fork commit. Classify every
conflicted file as `mechanical`, `seam-moved`, `retire-candidate`, or `human`; review rerere output as
a proposal, not proof; preserve every `Fork-*` trailer. Start the human-sync record immediately.

**Stop.** Show the human the rebased head, stack size, conflicts by class, all
`retire-candidate`/`human` rows, and any unresolved block. Continue only after every conflict has a
record row, or a zero-stop replay has the record schema's replay evidence.

### Gate 3 — Check

Walk every involved domain against the selected tag and run focused checks:

```bash
vp run fork:scan --head origin/hyprws --target "$tag"
vp run fork:delta --check
vp run --filter <touched-package> typecheck
vp test run <tests-beside-every-touched-file>
```

Replace the final two command arguments from the conflict and automerged-overlap file set; do not
leave those sample tokens in a command. A `MISSING` scan result is a gap in
`docs/internals/fork-delta.md` and must be recorded for the human to repair at Gate 4. Review every
automerged overlap even when the rebase never stopped.

Record exact commands and results. Product claims name the exact UI label and expected outcome; a
thread-sync claim uses a sent message, never a draft. Put typecheck-only findings under **Silent
seams**.

**Stop.** Show the human failed checks, silent seams, and the complete record. Continue only when the
scan, ledger, every targeted typecheck, and every adjacent test pass. Never substitute repo-wide
`vp check`, typecheck, or test for the targeted set; fork CI owns the full suite.

### Gate 4 — Human sanity

The human reads only decision rows and grounding claims:

```bash
rg '\| (retire-candidate|human) \|' "docs/operations/fork-sync-records/$tag.md"
rg 'Grounding (claim|pending)' "docs/operations/fork-sync-records/$tag.md"
```

The human resolves every decision by exact fork commit subject in the `Retired` or `Kept` section of
`docs/internals/fork-delta.md`, completes required desktop grounding, and replaces the absent marker
with `Human sanity: <login> YYYY-MM-DD`. The agent must not perform or infer this approval.

Commit the record and durable decisions on the rehearsal branch:

```bash
vp run fork:upstream-refs "docs/operations/fork-sync-records/$tag.md"
git add "docs/operations/fork-sync-records/$tag.md" docs/internals/fork-delta.md
git commit -m "docs(fork): record $tag rehearsal" \
  -m $'Fork-Domain: fork-meta\nFork-Tier: qol'
vp run fork:delta --check
vp run fork:scan --head origin/hyprws --target "$tag"
```

**Stop.** Show the human the sanity login/date, resolved subjects, grounding evidence, record commit,
and green checks. Continue only with a committed record and explicit human approval.

### Gate 5 — Apply

Run the deterministic guard from the rehearsed branch. `--allow-nightly` permits both supported tag
shapes while preserving stable-only behaviour when the flag is absent.

```bash
vp run fork:sync-gate --tag "$tag" --allow-nightly
```

The guard fetches and refuses an unmet preflight, invalid tag, missing record, stale `expected_old`,
or absent human sanity mark. If `origin/hyprws` moved, do not refresh only the SHA. Read and
incorporate the drift through [the rehearsal procedure](references/rehearse.md), update the evidence,
and repeat Gates 3–4.

**Stop.** The skill and agent never run the commands below. Resolve and print the exact values for
the human, who alone rewrites the trunk and records the resolution:

```bash
git push --force-with-lease=refs/heads/hyprws:"$expected_old" origin HEAD:hyprws
gh issue comment "$blocked_issue" -R RSI-Software/t3code-hyprws --body \
  "Resolved blocking upstream commit \`$blocking_sha\` while rebasing \`hyprws\` onto \`$tag\`; the leased rewrite replaced \`$expected_old\`."
```

A refused lease returns to rehearsal; it is never silently refreshed. Do not update a bot-owned ref
as part of this apply. The successful `hyprws` push starts a new bot run. That run closes every open
`rebase-blocked` issue if no block remains, or updates the issue when it finds a later block.

## Entry point: cut stable

Use this only for an open `release` issue created from a bot-owned
`release/vX.Y.Z-hyprws` snapshot. Never cut a stable from `hyprws`, `hyprws-next`, a rehearsal branch,
or a local commit. Never move the snapshot branch or replace an existing tag.

### Stable gate 1 — Identify

```bash
gh issue list --state open --label release \
  -R RSI-Software/t3code-hyprws
```

Read the selected issue and confirm its exact title is `Stable candidate vX.Y.Z-hyprws`, its body
names the matching snapshot, and the branch exists on `origin`. If several candidates are open, stop
for the human to select one; recency is not permission to choose.

### Stable gate 2 — Verify

Follow the runbook's exact [cut a stable release](../../../docs/operations/fork-sync.md#cut-a-stable-release)
preparation and verification blocks through `vp run test`. They derive the snapshot ref and next
release number from the selected issue, create a disposable Worktrunk lane at the exact remote
commit, and run the same preflight checks as the stable release workflow. Do not enter the separate
**Human-only publish** block.

**Stop.** Show the human the issue, snapshot branch and SHA, derived new tag, prior matching tags, and
all check results. Continue only when the worktree is clean, every check passes, the remote snapshot
still resolves to the checked SHA, and the tag does not already exist locally or remotely.

### Stable gate 3 — Publish

The skill and agent never create or push the stable tag. Hand the runbook's separate
**Human-only publish** block to the human only after Stable gate 2 stops. The human creates an
annotated `vX.Y.Z-hyprws.<n>` tag at the verified snapshot SHA, pushes it create-only, watches the
exact `hyprws-release.yml` run, verifies the `.AppImage` and `latest-linux.yml`, and closes the
candidate issue with the tag, snapshot SHA, and workflow URL.

A failed push or existing tag is a stop, not permission to increment again without re-running the
stable gates. A failed workflow leaves the candidate issue open. Bot run summaries record automatic
rewrites; human sync records remain under `docs/operations/fork-sync-records/` and are not created for
an ordinary stable cut from a bot snapshot.
