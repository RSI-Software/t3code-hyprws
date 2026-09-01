# Rehearsal record

Draft each record in a temporary Markdown file outside the repository. After human sign-off and the
post-sign-off checks, post it unchanged as a comment on the current `rebase-blocked` issue. The issue
comment is durable operational evidence; the record never becomes a stack file or commit. Existing
files under `docs/operations/fork-sync-records/` are read-only historical records from the former
flow.

A record states what the rehearsal decided and what it proved. A section that only restates the
stack is not evidence, so every shape below has a form for the case where there is nothing to report.

## Citing a commit subject

Code-span the whole subject wherever it appears, in a table cell and in prose:

```markdown
| `06f5d9d6dd` `fix(desktop): honor embedded browser wheel zoom (#169)` |
```

A squash appends `(#<number>)` to the subject, and that number is a fork pull request. Left bare, it
is a live reference: GitHub resolves it against `pingdotgg/t3code` and posts a backlink on an
unrelated upstream thread. `fork:upstream-refs` fails the file for exactly this reason.

Before posting the record, run the upstream-reference guard at the
[`fork-sync` Human sanity gate](../SKILL.md#gate-4--human-sanity) against `$record_path`; it must pass.

The same rule covers upstream citations, always as `pingdotgg/t3code#<number>` inside a code span.

The exception is `docs/internals/fork-delta.md`, where the subject stays plain text. The ledger
matcher compares that cell against the raw commit subject, so a code-spanned cell matches no commit.

## Schema

Use these sections in order.

### Header

```markdown
## Header

- Source: `origin/hyprws@<full-sha>`
- Target: `<target-tag>@<full-sha>`
- `expected_old`: `<full-sha>`
- Rehearsal branch: `rehearse/<target-tag>-from-<expected_old:12>`
- Rebased head: `<full-sha>`
- Stack size: `<count>` fork commits
- Human sanity: absent
```

Gate 4 replaces `absent` with `<login> YYYY-MM-DD`. `expected_old` is the exact published head read
before rehearsal and is never shortened. If the published head moves, the drift procedure updates
both Source and `expected_old` after the new commits have been read and incorporated.

`Stack size` is `git rev-list --count <target-tag>..HEAD` at `Rebased head`. It counts the rehearsed
stack, which is what the conflicts, commit table, and checks are evidence about. The record adds no
commit, so a clean rehearsal leaves that count unchanged. If Gate 4 commits a durable keep/retire
ledger decision, refresh `Rebased head`, `Stack size`, and every affected rehearsal SHA before
posting the comment.

A retirement drop also rewrites every SHA above the dropped commit. Re-derive the SHA column after
the drop; the subjects are what survive, the SHAs are not.

### Conflicts

One row per (fork commit, file), even when one commit conflicts in several files:

```markdown
| Fork commit | Domain | File | Hunks | Class | Effort | What upstream changed | Resolution | Agent-safe? |
| ----------- | ------ | ---- | ----: | ----- | ------ | --------------------- | ---------- | ----------- |
```

Use only the classes in [the rehearsal reference](rehearse.md), effort `S`/`M`/`L`, and `yes` or
`no` plus a reason for Agent-safe.

When the rebase stopped zero times, write `None.` and delete the table. A header and a divider with
no rows under them record nothing.

A zero-conflict replay still owes evidence that nothing was silently dropped. State it as a short
list under `None.`:

- `git rev-list --count <target-tag>..HEAD`, and the pre-rebase stack size it equals.
- That every subject is byte-identical and in the same order.
- That every full message, including every `Fork-Domain` and `Fork-Tier` trailer, is byte-identical.
- The `git config rerere.enabled` state, so a cached resolution is ruled in or out.

Name the head those counts were read at when a later gate changes the stack.

### Automerged overlap review

Required whenever the orientation report predicts a file that Git will automerge. A clean automerge
is not evidence that fork behaviour survived, and no rebase stop will raise it.

Classify each predicted file by comparing the rebased blob against the shared-base, fork, and
upstream blobs:

```markdown
| File | Fork changed it | Upstream changed it | Rebased result | Reading |
| ---- | --------------- | ------------------- | -------------- | ------- |
```

`Reading` states which behaviour survived and what would have been lost. A file where upstream now
supplies the fork behaviour is a retire candidate and takes a row in **Fork commits** too.

Write `None.` when the report predicts no overlap.

### Fork commits

One row per rehearsed fork commit that carries a decision, a claim, or a change. Put the exact
subject beside its rehearsal SHA because retirement decisions survive future SHA rewrites by subject.

```markdown
| Fork commit and exact subject | Domain | Class summary | Action | Grounding claim |
| ----------------------------- | ------ | ------------- | ------ | --------------- |
```

Action is `keep`, `retire`, `partial`, or `n/a`. Product claims name the exact UI label and expected
outcome, read from the surface under test rather than a neighbouring page. A thread-sync claim proves
a sent message, not text left in a draft. Use `n/a — no product grounding claim` when none applies.

A row is required when any of these holds:

- The commit conflicted in at least one file.
- The orientation report flagged it as a retire candidate, including when no conflict introduced it.
- Its decision is `retire` or `partial`, or its keep reason is one the next rebase needs.
- It carries a grounding claim.
- It entered or left the stack during this rehearsal, through a drift cherry-pick or a retirement
  drop.

Do not repeat the stack. In a clean replay most commits produce the same three cells, and eighty
rows reading `no content conflict` / `keep` / `n/a` are the stack, not the record. Close the table
with one line stating how many rehearsed commits replayed with no conflict and no decision, so the
count reconciles with `Stack size`.

Keep the class token in `Class summary` for a row that needs a human, because gate 4 finds decision
rows with `rg '\| (retire-candidate|human) \|'`.

The durable decision is copied, keyed by exact subject, into `docs/internals/fork-delta.md#retired`
or `docs/internals/fork-delta.md#kept`; do not treat a mutable SHA as its identity.

### Silent seams, verification, and grounding

- **Silent seams** lists findings exposed only by targeted typecheck or adjacent tests. Write `None.`
  when there were none.
- **Verification** records each exact command, pass/fail, and any remediation without weakening an
  assertion.
- **Grounding** has one `Grounding pending:` line per host-owned claim until gate 4 records evidence.
- End with the recommendation: `land`, `land-after-human-review-of-N`, or `do-not-land`.

## Worked examples

The historical [`v0.0.34`](../../../../docs/operations/fork-sync-records/v0.0.34.md) record is the
conflicted case. It contains 16 conflict-file rows across eight commits, the targeted checks and one
typecheck-only silent seam, and three exact grounding claims. It predates the sanity gate, so its
header deliberately says `Human sanity: absent` and the apply gate refuses it.

The historical [`v0.0.35`](../../../../docs/operations/fork-sync-records/v0.0.35.md) record is the
zero-conflict case. It replays the whole stack with no stop, so its evidence is the replay proof, the
automerged overlap review, and one retirement the orientation report raised without any conflict.
Use their schema content as examples, but post new records to the blocked issue instead of copying
their stack location.
