# Rehearsal procedure

A rehearsal is disposable Git topology but durable evidence. It runs only on `rehearse/<stable-tag>`
created from `origin/hyprws`; it never writes `hyprws`, `main`, a tag, or a remote ref.

## Before the rebase

1. Confirm the target is exactly `vX.Y.Z`, resolve `<tag>^{commit}`, and record both the full target
   SHA and `expected_old=$(git rev-parse origin/hyprws)`.
2. Install with `vp i` in the rehearsal worktree.
3. Read the feasibility conflicts, automerged overlap, each active domain's rebase scan, and open
   `upstream-watch` issues before changing a hunk.
4. Create `docs/operations/fork-sync-records/<tag>.md` from [the schema](record.md).

## At every rebase stop

For each file, inspect the upstream changes between the shared base and target before resolving it:

```bash
git log -p <shared-base>.."$tag" -- <file>
git show REBASE_HEAD -- <file>
```

Preserve upstream intent first. Reapply only the smallest fork behavior at the seam upstream now
provides. Review rerere output; it is a proposal, not proof. Keep the commit's subject and every
`Fork-*` trailer. Never `--skip`, squash, reorder, or casually reword a commit.

Record one conflict row per file using exactly one class:

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
3. Run `vp i` again if the target changed the lockfile, then `vp run fork:delta --check`.
4. Run targeted typecheck for every touched package and `vp test run` with tests beside every touched
   source/test file. Do not run repo-wide checks.
5. Put typecheck-only findings under **Silent seams**, fix them in the owning fork commit with a fixup
   and autosquash, then rerun the affected checks. Do not weaken upstream tests.
6. Complete exact grounding claims. The desktop Electron surface is authoritative before a fork
   release; browser operation and evidence remain human/host-owned.

## Trunk drift

A stale published head is a hard stop, not permission to refresh the lease.

1. Fetch `origin` and inspect `git log --oneline <recorded-expected-old>..origin/hyprws`.
2. Incorporate every newly published fork commit onto the rehearsed stack without changing its
   subject or trailers.
3. Update Source and `expected_old` to the newly read full SHA, plus the rebased head and stack size.
4. Run `vp run fork:delta --check` and
   `vp run fork:rebase-report --source HEAD --target "$tag"`; the report must show zero conflicts.
5. Repeat targeted typecheck/tests for touched seams and repeat human sanity. Never update only the
   SHA in the record.

## Human decision and apply boundary

The human reviews only `retire-candidate` and `human` rows, silent seams, and grounding claims. A
keep/retire/partial decision is keyed by exact commit subject and copied into the matching `Kept` or
`Retired` section of `docs/internals/fork-delta.md`. Only the human writes the sanity login/date.

The agent may run `vp run fork:sync-gate --tag <tag>` after that commit. It must stop before the
lease push, tag push, or release command and hand the exact values to the human.
