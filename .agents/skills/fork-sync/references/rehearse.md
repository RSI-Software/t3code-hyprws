# Rehearsal procedure

A rehearsal uses disposable Git topology and an external draft that becomes durable issue evidence.
It runs only on `rehearse/<target-tag>-from-<expected_old:12>` created from the published head that
name records; before apply, it never writes
`hyprws`, `main`, a tag, or a remote ref. Its operational record never enters the repository.

## Before the rebase

1. Confirm the target is exactly `vX.Y.Z` or `vX.Y.Z-nightly.YYYYMMDD.<run>`, resolve
   `<tag>^{commit}`, and record both the full target SHA and
   `expected_old=$(git rev-parse origin/hyprws)`. Read that lease exactly once at rehearsal start.
2. Install with `vp i` in the rehearsal worktree, then restore `pnpm-lock.yaml` from `HEAD`. The
   install re-resolves floating transitive versions, and `git rebase` will not start on a dirty
   tree.
3. Read the feasibility conflicts, automerged overlap, each active domain's rebase scan, and open
   `upstream-watch` issues before changing a hunk.
4. Create `$record_path` with `mktemp` outside the repository and fill it from
   [the schema](record.md). Never stage it or copy it into the worktree.

## At every rebase stop

For each file, inspect the upstream changes between the shared base and target before resolving it:

```bash
git log -p <shared-base>.."$tag" -- <file>
git show REBASE_HEAD -- <file>
```

Preserve upstream intent first. Reapply only the smallest fork behavior at the seam upstream now
provides. Review rerere output; it is a proposal, not proof. Keep the commit's subject and every
`Fork-*` trailer. Never `--skip`, squash, reorder, or casually reword a commit.

`pnpm-lock.yaml` is generated state, not a semantic seam. When it is part of the stop, follow the
[`fork-sync` Rehearse gate](../SKILL.md#gate-2--rehearse) for the executable regeneration sequence:
discard both the textual conflict and any rerere proposal by restoring the current replay base,
resolve and stage all other conflicts, then regenerate and stage the lockfile from the combined
manifests.

During a rebase, `HEAD` is the incoming upstream base plus fork commits already replayed. The
repository-native `vp install --lockfile-only` command is equivalent to
`pnpm install --lockfile-only`; it applies the current fork commit's manifest changes without
carrying its old generated lockfile forward.

Record one conflict row per file using exactly one class:

- **`generated`** — a registered regenerable path. Keep the new-base side and run its registered
  generator; never splice generated entries or accept a cached textual resolution.
- **`mechanical`** — both changes are additive or adjacent with no semantic overlap. Combine them
  without weakening either side.
- **`seam-moved`** — upstream moved or renamed the hook point. Rebuild the same fork behavior at the
  new boundary rather than retaining dead structure.
- **`retire-candidate`** — upstream may now provide the behavior. Keep the smallest buildable fork
  behavior for rehearsal and require a human keep/retire decision; do not delete it by judgement.
- **`human`** — product intent or safety has more than one defensible resolution. Apply the smallest
  testable proposal, document its alternative, and stop for human choice.

Use effort `S` for local/additive resolution, `M` for a moved seam or cross-file reasoning, and `L`
for a cross-domain or architectural rebuild. Mark Agent-safe `no` whenever retirement or product
judgement remains.

## After the rebase

1. Count `git rev-list --count "$tag"..HEAD`; the record's commit table has exactly that many rows,
   keyed by exact subjects.
2. Walk rebase-scan paths and automerged overlap for every involved domain. A clean merge is not
   evidence that behavior survived.
3. If the target or replay changed a package manifest or `pnpm-lock.yaml`, run
   `vp install --lockfile-only` again on the completed replay and require an unchanged worktree. If
   it produces drift, fold the regenerated lockfile into the fork commit that changed the matching
   manifests without changing that commit's subject or trailers, then repeat the rebase checks. Run
   `vp i` when installed dependencies also need refreshing, then `vp run fork:delta --check`.
4. Run targeted typecheck for every touched package and `vp test run` with tests beside every touched
   source/test file. Do not run repo-wide checks.
5. Put typecheck-only findings under **Silent seams**, fix them in the owning fork commit, then rerun
   the affected checks. Commit the fix as `git commit --fixup <fork-commit>` and fold it in with the
   form below; bare `git rebase --autosquash` needs Git 2.44, so it silently leaves the `fixup!`
   commit in the stack on an older Git.

   ```bash
   GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash "$tag"
   ```

   Do not weaken upstream tests.

6. Complete exact grounding claims. The desktop Electron surface is authoritative before a fork
   release; browser operation and evidence remain human/host-owned.

## Trunk drift

A stale published head is a hard stop. Never refresh `expected_old` in the existing rehearsal or
record.

1. Fetch `origin` and inspect `git log --oneline <recorded-expected-old>..origin/hyprws`.
2. Start a new rehearsal from the updated `origin/hyprws`, reading its new `expected_old` exactly
   once before creating the lane. The new head gives the lane a new name, so it never collides with
   the stale one; leave that lane and its worktree in place as evidence.
3. On that new lane, incorporate every newly published fork commit without changing its subject or
   trailers, then record the new Source, rebased head, and stack size. Prior conflict resolutions,
   including rerere, are candidates for reuse, not proof; run the checks below in full.
4. Run `vp run fork:delta --check` and
   `vp run fork:rebase-report --source HEAD --target "$tag"`; the report must show zero conflicts.
5. Repeat targeted typecheck/tests for touched seams, rebuild the evidence, and obtain new human
   sign-off. Never update only the SHA in the record.

## Human sign-off and agent apply boundary

The agent presents the `retire-candidate` and `human` rows, silent seams, and grounding evidence. The
human replies with every keep/retire/partial decision keyed by exact commit subject, confirms the
grounding evidence, records their login and date, and gives an explicit go. Missing sign-off is a
hard stop. The agent copies those decisions into the matching `Kept` or `Retired` section of
`docs/internals/fork-delta.md` and writes `Human sanity: <login> YYYY-MM-DD` from the recorded
sign-off; it never performs or infers the approval.

After any durable ledger decision commit, refresh the external record's final head and stack count,
rerun the checks, and post the signed record as a new comment on the blocked issue. The agent then
runs `vp run fork:sync-gate --tag <tag> --record "$record_path"` for a stable target or adds
`--allow-nightly` for a nightly target. The gate refuses a record inside the repository, and its
refusals are never bypassed. Once it passes, the agent pushes with
`--force-with-lease=refs/heads/hyprws:<expected_old>` and posts the runbook apply comment with the
record-comment URL. A stale lease is never refreshed: start a new rehearsal, read its lease once,
repeat the evidence and human sign-off, and post a fresh record comment before applying.
