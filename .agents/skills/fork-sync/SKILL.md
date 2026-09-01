---
name: fork-sync
description: Unblock an RSI-Software/t3code-hyprws upstream rebase with a gated rehearsal and leased apply, or cut a stable fork release from a bot-owned snapshot.
---

# Fork sync

Choose exactly one entry point:

- **unblock** — resolve the current `rebase-blocked` issue by rehearsing the complete fork stack on
  the selected upstream stable or nightly tag;
- **cut stable** — verify a bot-owned `release/vX.Y.Z-hyprws` snapshot, obtain human sign-off on the
  exact candidate, and publish its immutable stable tag.

Never post to `pingdotgg/t3code`. Never merge upstream into `hyprws`. Never move
`hyprws-previous`, `hyprws-next`, or `release/vX.Y.Z-hyprws` by hand. The
[fork-sync runbook](../../../docs/operations/fork-sync.md) owns the bot model, ref meanings,
repository setup, failure handling, and local-lane recovery.

## Entry point: unblock

This flow has five gates with hard stops for unmet prerequisites and missing human sign-off. The
rewrite is rehearsed away from the `hyprws` worktree. After sign-off, the agent applies it with the
expected-old lease read once at the start of that same rehearsal.

Set `tag` to the newest upstream release tag beyond the blocking commit that the human intends to
reach. Both `vX.Y.Z` and `vX.Y.Z-nightly.YYYYMMDD.<run>` are valid targets. Draft the record in a
temporary file outside the repository; after sign-off, post that file as a comment on the blocked
issue. Never add it to the replayed stack. Follow [the record schema](references/record.md) and
[the rehearsal procedure](references/rehearse.md), treating `$tag` as the selected release tag when
it is a nightly. The block below assigns `tag` after the tag listing, because the listing is what the
selection is made from.

### Gate 1 — Orient

The preflight fetches both lanes and proves the `main` mirror is current. Read the open block, sweep
upstream watches, list reachable release tags, and orient against the human's selection:

```bash
node scripts/fork-preflight.ts
repo=RSI-Software/t3code-hyprws
blocked_issue="$(gh issue list --state open --label rebase-blocked -R "$repo" \
  --json number --jq 'if length == 1 then .[0].number else error("expected one open rebase-blocked issue") end')"
gh issue view "$blocked_issue" -R "$repo"
gh issue view "$blocked_issue" --comments -R "$repo"
node scripts/fork-upstream-watch.ts
git tag --list 'v*' --sort=-v:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-nightly\.[0-9]{8}\.[0-9]+)?$' \
  | head -n 10
tag= # fill from the list above with the release tag the human selects
node scripts/fork-orient.ts --target "$tag"
```

`node` is deliberate: these scripts use Node builtins and can name preflight failures before `vp i`.
The blocked issue is read twice because `--comments` replaces the body view rather than adding to
it: the body carries the full `blocking-sha`, and the comments carry the bot's refresh log, which
abbreviates it.
Orientation proves the target exists as a tag, is reachable from `upstream/main`, and reports
feasibility, automerged overlap, retire candidates, and `upstream-watch` verdicts. The selected tag
must be beyond the blocking upstream commit; choosing the last clean tag only reproduces the bot's
current result.

**Stop.** Show the human the issue's blocking SHA, target tag and SHA, source and shared base,
conflict/overlap summary, and watch verdicts. Record the full blocking SHA as `blocking_sha` for the
closing comment. Continue only after the human confirms the target. Orientation is not permission to
modify a ref.

### Gate 2 — Rehearse

Create a disposable lane from the published fork; never rebase the current checkout. Read
`expected_old` exactly once, before the lane exists, and name the lane after it:

```bash
git fetch origin --quiet
expected_old="$(git rev-parse origin/hyprws)"
wt switch --create "rehearse/$tag-from-${expected_old:0:12}" --base "$expected_old"
# Continue in the worktree path printed by Worktrunk.
vp i
# `vp i` re-resolves floating transitive versions, so it can leave the registered generated
# lockfile dirty, and `git rebase` refuses to start on a dirty tree. Restore it: the replay
# re-derives it at each stop, and the after-rebase check owns the final drift.
git restore --source=HEAD --worktree -- pnpm-lock.yaml
# Git strips comment-char lines from any message it rewrites, which silently deletes the `##`
# headings fork bodies use. Export it so every later git call in this shell inherits it,
# including `rebase --continue`; never write it into the shared repository config.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.commentChar GIT_CONFIG_VALUE_0=auto
target_sha="$(git rev-parse "$tag^{commit}")"
base_sha="$(git merge-base "$expected_old" "$tag")"
record_path="$(mktemp "${TMPDIR:-/tmp}/fork-sync-${tag}.XXXXXX.md")"
messages_path="$(mktemp "${TMPDIR:-/tmp}/fork-sync-${tag}-messages.XXXXXX")"
chmod 600 "$record_path" "$messages_path"
git log --reverse --topo-order --format='%B%x1e' "$base_sha..$expected_old" > "$messages_path"
git rebase "$tag"
```

The lane name carries the published head it replays, so a target rehearsed against a since-advanced
trunk gets a new lane instead of colliding with the stale one. Basing the lane on `$expected_old`
rather than `origin/hyprws` keeps the name and the replayed head the same commit even if the remote
advances mid-run. The stale lane stays where it is; it is evidence, and its resolutions are reuse
candidates rather than proof.

At each stop, read upstream intent first, preserve it, and reapply the smallest fork behaviour at the
current seam. `pnpm-lock.yaml` is the registered `generated` conflict class: restore it from `HEAD`
(the incoming upstream base plus already replayed fork commits), resolve every non-generated
conflict, then re-derive and stage it instead of merging lockfile entries:

```bash
git restore --source=HEAD --staged --worktree -- pnpm-lock.yaml
# Resolve and stage every remaining conflict before running the generator.
vp install --lockfile-only
git add pnpm-lock.yaml
```

`vp install --lockfile-only` is the repository-native equivalent of
`pnpm install --lockfile-only`. Apply this rule even when rerere proposes or stages a prior lockfile
resolution; generated state is not a reusable resolution. Never squash, reorder, reword, or
`git rebase --skip` a fork commit. Classify every other conflicted file as `mechanical`,
`seam-moved`, `retire-candidate`, or `human`; preserve every `Fork-*` trailer. Start the human-sync
record immediately at `$record_path`, never under the repository root.

**Stop.** Show the human the rebased head, stack size, conflicts by class, all
`retire-candidate`/`human` rows, and any unresolved block. Continue only after every conflict has a
record row, or a zero-stop replay has the record schema's replay evidence.

### Gate 3 — Check

Walk every involved domain against the selected tag and run focused checks:

```bash
git log --reverse --topo-order --format='%B%x1e' "$tag..HEAD" | diff -u "$messages_path" -
vp run fork:scan --target "$tag"
vp run fork:delta --check
vp run --filter <touched-package> typecheck
vp test run <tests-beside-every-touched-file>
```

The `diff` proves no commit message changed during the replay; any output is a hard stop, not a
finding to record.

`fork:scan` takes no `--head` here on purpose: it defaults to the checkout `HEAD`, and only a scan
of the checkout `HEAD` runs the typechecks that surface silent seams. The pre-rebase overlap walk
already happened at Gate 1 through `fork-orient.ts`.

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

At the sign-off boundary, the human reads only decision rows and grounding claims:

```bash
rg '\| (retire-candidate|human) \|' "$record_path"
rg 'Grounding (claim|pending)' "$record_path"
```

**Stop.** Present every decision by exact fork commit subject, every silent seam, and all grounding
evidence. Continue only when the human replies with the keep/retire/partial decisions, confirms the
grounding evidence, records their login and date, and gives an explicit go. Missing sign-off is a
hard stop; the agent must not perform or infer this approval.

After sign-off, the agent copies the decisions into the matching `Retired` or `Kept` section of
`docs/internals/fork-delta.md` and writes `Human sanity: <login> YYYY-MM-DD` with the login and date
from that sign-off. Commit only durable delta decisions, never the rehearsal record. After any such
commit, refresh the record's rebased head, stack count, and affected rehearsal SHAs before posting
it:

```bash
git add docs/internals/fork-delta.md
if ! git diff --cached --quiet; then
  git commit -m "docs(fork): apply rehearsal decisions" \
    -m $'Fork-Domain: fork-meta\nFork-Tier: qol'
fi
vp run fork:upstream-refs "$record_path"
vp run fork:delta --check
vp run fork:scan --target "$tag"
record_comment_url="$(gh issue comment "$blocked_issue" -R "$repo" --body-file "$record_path")"
```

The issue comment is the durable operational record. A clean rehearsal may leave no new commit; a
keep/retire ledger edit remains replayable delta input. Any failure returns the rehearsal to Gate 3.
A red check or source edit voids the sign-off and requires a fresh record comment after the fix; do
not edit or delete an earlier rehearsal comment.

### Gate 5 — Apply

Run the deterministic guard from the rehearsed branch. `--allow-nightly` permits both supported tag
shapes while preserving stable-only behaviour when the flag is absent.

```bash
vp run fork:sync-gate --tag "$tag" --record "$record_path" --allow-nightly
```

The guard fetches and refuses an unmet preflight, invalid tag, record inside the repository, missing
record, stale `expected_old`, or absent human sanity mark. Its refusals are never bypassed. If
`origin/hyprws` moved, do not refresh only the SHA: start a new rehearsal, read its lease once,
incorporate the drift through [the rehearsal
procedure](references/rehearse.md), update the evidence, and repeat Gates 3–4.

After the gate passes against the recorded sign-off, the agent resolves the exact values, rewrites
the trunk with the recorded lease, and posts the runbook issue comment:

```bash
git push --force-with-lease=refs/heads/hyprws:"$expected_old" origin HEAD:hyprws
gh issue comment "$blocked_issue" -R RSI-Software/t3code-hyprws --body \
  "Resolved blocking upstream commit \`$blocking_sha\` while rebasing \`hyprws\` onto \`$tag\`; the leased rewrite replaced \`$expected_old\`. Rehearsal record: $record_comment_url"
rm "$record_path"
```

A refused lease returns to a full rehearsal; it is never silently refreshed. Keep the external
record until a successful apply comment, but never commit it. Do not update a bot-owned ref as part
of this apply. The successful `hyprws` push starts a new bot run. That run
closes every open `rebase-blocked` issue if no block remains, or updates the issue when it finds a
later block.

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
commit, and run the same preflight checks as the stable release workflow.

Before tagging, run `vp run fork:uat --ref origin/release/vX.Y.Z-hyprws --relates-to N` under the
[`fork-uat`](../fork-uat/SKILL.md) judgment boundary on the exact ref you intend to tag, then read the
created UAT issue. The candidate issue is optional relationship context, never the UAT input. The
checked rows and latest human `Signed off` or `Blocked: <reason>` comment are sign-off evidence; they
inform the release judgment and never gate it automatically.

**Stop.** Show the human the issue, snapshot branch and SHA, derived new tag, prior matching tags,
and all check results. Continue only when the worktree is clean, every check passes,
the remote snapshot still resolves to the checked SHA, the tag does not already exist locally or
remotely, and the human records the exact candidate and an explicit go. Missing sign-off is a hard
stop.

### Stable gate 3 — Publish

After the human signs off, the agent creates an annotated `vX.Y.Z-hyprws.<n>` tag at the verified
snapshot SHA, pushes it create-only, watches the exact `hyprws-release.yml` run, verifies the
`.AppImage` and `latest-linux.yml`, and closes the candidate issue with the tag, snapshot SHA, and
workflow URL.

A failed push or existing tag is a stop, not permission to increment again without re-running the
stable gates and obtaining fresh sign-off. A failed workflow leaves the candidate issue open. Bot
run summaries record automatic rewrites; human rehearsal records are comments on their blocked
issues. An ordinary stable cut from a bot snapshot creates neither kind of rehearsal record.
