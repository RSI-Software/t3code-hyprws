# Unblock

Replay the fork onto one upstream tag and land it under an expected-old lease.
[SKILL.md](../SKILL.md) owns the never-rules and the stop shape; this file owns the judgement.

The [runbook](../../../../docs/operations/fork-sync.md#unblocking-a-rebase-blocked-issue) owns every mechanic below: worktree setup, verb contracts, repair scope, and refusal lists.
Read it when the walk stops or you are driving a verb by hand.

## Tagged upstream replay

```bash
vp run fork:sync unblock-auto [--target tag@sha] [--report <path>]
```

One invocation walks one eligible tag to the end and asks for nothing.
It selects the target, resolves every conflict, repairs the lane, applies under the lease, and appends the churn row.

There is no `--resume`: a report already on disk is a walk in flight.
Conflicts are machine-owned and never yours to pre-empt, under the [conflict doctrine](../../../../docs/operations/fork-sync.md#conflict-doctrine).

### The two legal stops

A stop halts the walk; it does not summon a human by itself.
Both are written into the report and the notification issue.

| Stop          | Cause                                     | Yours to resolve      |
| ------------- | ----------------------------------------- | --------------------- |
| `environment` | The lane cannot test at all               | No                    |
| `conflict`    | The executor declined a row               | When it triages clear |
| `conflict`    | A staged fix fails typecheck or its tests | When it triages clear |

Anything else that halts the walk is a bug in the walk.
Pick a stopped walk up by hand with the [manual verbs](#manual-verbs).

A `conflict` stop hands you the row; it does not hand it to the human.
Resolve every `clear` row and walk on, and stop only for a `judgement` row.
That stop alone is a human decision and is recorded as one.

After resolving and staging the declined paths, flush them with `record-decisions` so the next tag's walk reads the seam from the record ([decision records](../../../../docs/operations/fork-sync.md#decision-records)).
No maintainer decides the same seam twice.

## Retirement

Retirement stays human.
Only a `retire` verdict written in the fork delta ledger drops a fork commit.
The walk keeps every candidate regardless of what the target tree carries.

### The retire-candidate test

In steps 3 and 4, ask of every `retire-candidate`: does the upstream hunk implement the fork behaviour?
If the row does not make that obvious, show both hunks first: the `git diff` of the fork commit's hunk, and the upstream hunk.

Answer yes, which `target-tree: <name> at <file>:<line>` usually proves:

- **Default verdict:** `retire`
- **Upstream wins:** it is the same-shape feature
- **Fork keeps:** policy or behaviour upstream lacks
- **Reapplied at** upstream's seam
- **Keep or keep-both:** a `judgement` line
- **Naming** what upstream's version loses

The default is `retire`, per `RSI-Software/t3code-hyprws#665`.
The reason goes in the decision cell.
A keep with no named reason is not a recordable decision.

Treat `mechanical` and `seam-moved` rows as `clear` unless the resolution dropped or moved fork behaviour.

### Orientation verdicts

`unblock-orient` already runs the test for an orientation candidate, searching the target tag's tree for the identifiers the fork commit introduces and writing the verdict into the row's class summary.

- **`target-tree: absent`:** a proven keep
- **A named hit:** show both hunks first
- **Reads:** product source only
- **Never:** vendored, harness, CI, editor, docs
- **Counts:** only a define or import in the target
- **Only in:** a file type the fork commit changed

A name that merely appears in the tree is a sighting of the word, not of the behaviour, so it never reaches the row.

## Manual verbs

`unblock-auto` runs every verb in one invocation, so these are not the normal path.
Use them for diagnostics, for teaching, for a series rewrite, and for picking up a stopped walk by hand.
Each verb's contract is the [verb ladder](../../../../docs/operations/fork-sync.md#verb-ladder); what follows is only where you stop and what you judge.

Pause the bot for the whole ladder first ([walk pause](../../../../docs/operations/fork-sync.md#walk-pause)).

- **Each command** consumes the prior report
- **Never** alter its state
- **Never** continue a rebase directly

### 1. List

**Stop.** Apply the stop shape to the blocker and offered tags.

- **Recommend:** the tag an open sub-issue names
- **Its title:** `unblock walk lands <tag>`
- **None open:** newest offered tag with the block
- **Name** which rule fired
- **Require** the human's exact tag

### 2. Orient

**Stop.** Apply the stop shape to the target, source, and shared-base SHAs, the conflicts, the automerged overlap, the retire candidates, and the watch verdicts.
Continue only after the human confirms the exact target.

### 3. Rehearse

Preserve upstream intent and classify each non-generated row `mechanical`, `seam-moved`, `retire-candidate`, or `human`.

Classify and resolve `mechanical` and `seam-moved` rows yourself, then continue.
Only a `retire-candidate` or `human` row stops, and only the human's exact classification may be recorded for it.

**Stop only if one exists.** Apply the stop shape and the retire-candidate test to those rows.
A clean replay still owes the report's count and byte-identical-message proof.

### 4. Check

The check repairs what it can and hands back what it cannot ([lane repair](../../../../docs/operations/fork-sync.md#lane-repair), [additive proof](../../../../docs/operations/fork-sync.md#additive-proof)).
Never substitute repo-wide local checks.

**Stop.** On an objective nightly lane the `checked` report already carries its proposer, so hand the Gate 4 surface, report, and record straight to a reviewer in another session, under the [review gate](#series-rewrite-review).

On a judgement lane, apply the stop shape and the retire-candidate test to the emitted Gate 4 decision surface, silent seams, and grounding evidence.

- **Failed gate:** the failing job names, verbatim
- **Plus:** the last 40 log lines, uninterpreted
- **Grounding claim named:** confirm that too

#### The `Decided by` cell

- **Write** the decider beside every action filled
- **A `TODO` cell** records no decision
- **Counts** for nobody in the churn ledger
- **Refused** at apply
- **A rerun or refresh** keeps filled cells
- **Filled wins** over a reclassifying rerun

A refresh names any cell it drops for a subject that left the replay.

### 5. Apply

A series rewrite requires the review gate below.
Rejection voids the report: retain its external files, restart at step 1, and never commit them.

### 6. Ledger row

Step 5 already published it on `refs/fork/churn`.
Run the append by hand only for a row no apply wrote ([churn ledger](../../../../docs/operations/fork-sync.md#churn-ledger)).

## Same-base historical preparation

Only for reconstructing the original fork patches, never an upstream replay.
Finish the reviewed executable manifest and run the gate ladder from [historical rewrite construction](../../../../docs/operations/fork-sync.md#historical-rewrite-construction); the design-only report is not executable.
Keep every unresolved proof gate explicit, because the constructor refuses it.

Never invent eligibility to get through the gate, and expect no proof relaxation.
Missing outcome evidence needs reviewed reconciliation, not a substituted candidate.

Set `FORK_OUTCOME_EXECUTOR=agent` on operator auto, check, and apply invocations, and publish their retained outcome evidence.
A same-base rewrite is an attempt on the existing target, not an upstream advance or an unattended success.
After it applies, start a fresh tagged report for the actual upstream replay.

## Series rewrite review

The review belongs to the series rewrite, not to the walk.
Hand the emitted report and record paths to a reviewer in another session, who records exactly one result ([series rewrite review](../../../../docs/operations/fork-sync.md#series-rewrite-review)).

### Withhold for

- **Undefined** fork intent
- **Non-equivalent** retire
- **User-visible** behaviour change
- **Topology:** a fork domain or tier change
- **Any** bypass
- **Unverifiable** evidence

### Boundaries

- **Never** call this reviewer human
- **Never** review from the proposing session
- **Never** copy a handoff between sessions
- **Gate refuses:** a missing or stale review
- **Gate refuses:** a same-session or withheld one

The unblock walk is exempt, carrying no agent judgement verdict: its outcomes come from doctrine the code applies, and it escalates only the rows that doctrine reserves for a human.
