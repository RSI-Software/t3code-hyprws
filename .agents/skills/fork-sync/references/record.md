# Rehearsal record

Records live at `docs/operations/fork-sync-records/<stable-tag>.md` and are committed on the
rehearsed stack. They are evidence carried into the next tag, not disposable agent notes.

## Schema

Use these sections in order.

### Header

```markdown
## Header

- Source: `origin/hyprws@<full-sha>`
- Target: `<stable-tag>@<full-sha>`
- `expected_old`: `<full-sha>`
- Rehearsal branch: `rehearse/<stable-tag>`
- Rebased head: `<full-sha>`
- Stack size: `<count>` fork commits
- Human sanity: absent
```

Gate 4 replaces `absent` with `<login> YYYY-MM-DD`. `expected_old` is the exact published head read
before rehearsal and is never shortened. If the published head moves, the drift procedure updates
both Source and `expected_old` after the new commits have been read and incorporated.

### Conflicts

One row per (fork commit, file), even when one commit conflicts in several files:

```markdown
| Fork commit | Domain | File | Hunks | Class | Effort | What upstream changed | Resolution | Agent-safe? |
| ----------- | ------ | ---- | ----: | ----- | ------ | --------------------- | ---------- | ----------- |
```

Use only the classes in [the rehearsal reference](rehearse.md), effort `S`/`M`/`L`, and `yes` or
`no` plus a reason for Agent-safe. Code-span every upstream citation as
`pingdotgg/t3code#<number>`; never write a bare `#<number>`, which links to a nonexistent fork issue.

### Fork commits

One row per rehearsed fork commit. Put the exact subject beside its rehearsal SHA because retirement
decisions survive future SHA rewrites by subject.

```markdown
| Fork commit and exact subject | Domain | Class summary | Action | Grounding claim |
| ----------------------------- | ------ | ------------- | ------ | --------------- |
```

Action is `keep`, `retire`, `partial`, or `n/a`. Product claims name the exact UI label and expected
outcome. A thread-sync claim proves a sent message, not text left in a draft. Use `n/a — no product
grounding claim` when none applies.

The durable decision is copied, keyed by exact subject, into `docs/internals/fork-delta.md#retired`
or `docs/internals/fork-delta.md#kept`; do not treat a mutable SHA as its identity.

### Silent seams, verification, and grounding

- **Silent seams** lists findings exposed only by targeted typecheck or adjacent tests. Write `None.`
  when there were none.
- **Verification** records each exact command, pass/fail, and any remediation without weakening an
  assertion.
- **Grounding** has one `Grounding pending:` line per host-owned claim until gate 4 records evidence.
- End with the recommendation: `land`, `land-after-human-review-of-N`, or `do-not-land`.

## Worked example

[`v0.0.34`](../../../../docs/operations/fork-sync-records/v0.0.34.md) is the first worked record. It
contains 16 conflict-file rows across eight commits, one row for every one of the 64 rehearsed fork
commits, the targeted checks and one typecheck-only silent seam, and three exact grounding claims.
It predates the sanity gate, so its header deliberately says `Human sanity: absent` and the apply
gate refuses it.
