# Unblock

Replay the fork onto one upstream tag and land it under an expected-old lease.
[SKILL.md](../SKILL.md) owns the never-rules and the stop shape; this file owns the judgement.

The [runbook](../../../../docs/fork/operations/fork-sync.md#unblocking-a-rebase-blocked-issue) owns every mechanic below: worktree setup, verb contracts, repair scope, and refusal lists.
Read it when the walk stops or you are driving a verb by hand.

## Tagged upstream replay

```bash
vp run fork:sync unblock-auto [--target tag@sha] [--report <path>]
```

One invocation walks one eligible tag to the end and asks for nothing.
It selects the target, resolves every conflict, repairs the lane, applies under the lease, and appends the churn row.

There is no `--resume`: a report already on disk is a walk in flight.
Conflicts are machine-owned and never yours to pre-empt, under the [conflict doctrine](../../../../docs/fork/operations/fork-sync.md#conflict-doctrine).

Run every verb in the foreground and read its exit; never poll its log with a sleep loop.

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
Trace every row, resolve every `clear`, walk on, and stop only for a `judgement` row.
That stop alone is a human decision and is recorded as one.

After resolving and staging the declined paths, flush them with `record-decisions` so the next tag's walk reads the seam from the record ([decision records](../../../../docs/fork/operations/fork-sync.md#decision-records)).
No maintainer decides the same seam twice.

## Retirement

You retire.
Only a `retire` verdict written in the fork delta ledger drops a fork commit, and the trace writes it.
The walk keeps every candidate until that row exists.

### The retire-candidate test

In steps 3 and 4, ask of every `retire-candidate`: does the upstream hunk implement the fork behaviour?
Read both hunks: the `git diff` of the fork commit's hunk, and the upstream hunk.

Answer yes, which `target-tree: <name> at <file>:<line>` usually proves:

- **Default verdict:** `retire`
- **Upstream wins:** it is the same-shape feature
- **Fork keeps:** policy or behaviour upstream lacks
- **Reapplied at** upstream's seam
- **Keep or keep-both:** name what upstream loses
- **Doubt** after both hunks: a `judgement` line

The default is `retire`, per `RSI-Software/t3code-hyprws#665`.
The reason goes in the decision cell, with `Decided by: agent`.
A keep with no named reason is not a recordable decision.

Treat `mechanical` and `seam-moved` rows as `clear` unless the resolution dropped or moved fork behaviour.

### Orientation verdicts

`unblock-orient` already runs the test for an orientation candidate, searching the target tag's tree for the identifiers the fork commit introduces and writing the verdict into the row's class summary.

- **`target-tree: absent`:** a proven keep
- **Settled:** `matches: []` or an inherited verdict
- **Copy** a settled verdict; never re-trace it
- **A named hit:** show both hunks first

#### What the search counts

- **Reads:** product source only
- **Never:** vendored, harness, CI, editor, docs
- **Counts:** only a define or import in the target
- **Only in:** a file type the fork commit changed

A name that merely appears in the tree is a sighting of the word, not of the behaviour, so it never reaches the row.

## The `upstream/main state` column

The blocked issue's census table carries one extra column per row: the same fork commit and path replayed against live `origin/main`.

| Value                | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `conflict`           | That path conflicts on `main` too                                |
| `not observed`       | Complete matching-source evidence saw no conflict                |
| `unknown (<reason>)` | No verdict: `partial`, `unavailable`, `stale`, `source-mismatch` |

It is advisory. It selects no tag, applies nothing, and retires nothing.

A conflicting pull request gets one sticky comment; a clean one gets none.
`main` conflicts surface only when a tag rebase runs, so no eligible tag means no forecast.

## Manual verbs

`unblock-auto` runs every verb in one invocation, so these are not the normal path.
Use them for diagnostics, for teaching, for a series rewrite, and for picking up a stopped walk by hand.
Each verb's contract is the [verb ladder](../../../../docs/fork/operations/fork-sync.md#verb-ladder); what follows is only where you stop and what you judge.

Pause the bot for the whole ladder first ([walk pause](../../../../docs/fork/operations/fork-sync.md#walk-pause)).

- **Each command** consumes the prior report
- **Report:** the only authority the gate and apply read
- **Never** alter its state
- **Never** continue a rebase directly

A report written before typed authority is refused, never converted: rerun the walk from step 1.

### 1. List

Pick the target yourself; `unblock-auto` does the same.

- **First:** the tag an open sub-issue names
- **Its title:** `unblock walk lands <tag>`
- **None open:** newest offered tag with the block
- **Record** which rule fired
- **Stop** only when no rule matches

### 2. Orient

Read the target, source, and shared-base SHAs, the conflicts, the automerged overlap, the retire candidates, and the watch verdicts.
Continue; the report carries them for the human later.

### 3. Rehearse

Preserve upstream intent and classify each non-generated row `mechanical`, `seam-moved`, `retire-candidate`, or `human`.

Classify and resolve `mechanical` and `seam-moved` rows yourself, then continue.
Trace every `retire-candidate` and `human` row, write the verdict with `Decided by: agent`, and continue.

**Stop only on doubt.** Apply the stop shape to the row the trace could not settle.
A clean replay still owes the report's count and byte-identical-message proof.

**Trace note:** one scratch file per walk, beside the report, one line per fork SHA traced.
After a compaction, read the note; never re-run `git show` on a SHA it names.

### 4. Check

The check repairs what it can and hands back what it cannot ([lane repair](../../../../docs/fork/operations/fork-sync.md#lane-repair), [additive proof](../../../../docs/fork/operations/fork-sync.md#additive-proof)).
Never substitute repo-wide local checks, and never pre-run the lane battery.
Repair only what the handback names, then rerun the verb.

**Stop.** On an objective nightly lane the `checked` report already carries its proposer, so hand the Gate 4 surface, report, and record straight to a reviewer in another session, under the [review gate](#series-rewrite-review).

On a judgement lane, apply the stop shape and the retire-candidate test to the emitted Gate 4 decision surface, silent seams, and grounding evidence.

- **Failed gate:** the failing job names, verbatim
- **Log:** last 40 lines, raw, in the issue
- **Reply:** job names and the one line that failed
- **Grounding claim named:** confirm that too

#### Deciding a declined row

A declined row is decided by typed, signed input or not at all.

```bash
vp run fork:sync record-decisions --report <report.json> --input <decisions.json>
```

- **Bound** to the report's source, target, and lease
- **Each entry** names the row identity, resolution, and decider
- **Unknown** or duplicate identity: refused
- **Unsigned** decision: refused
- **Editing** the published record decides nothing

A rerun keeps recorded decisions, and a recorded decision wins over a reclassifying rerun.
A refresh names any decision it drops for a subject that left the replay.

### 5. Apply

A series rewrite requires the review gate below.
Rejection voids the report: retain its external files, restart at step 1, and never commit them.

### 6. Ledger row

Step 5 already published it on `refs/fork/churn`.
Run the append by hand only for a row no apply wrote ([churn ledger](../../../../docs/fork/operations/fork-sync.md#churn-ledger)).

## Same-base historical preparation

Only for reconstructing the original fork patches, never an upstream replay.
Finish the reviewed executable manifest and run the gate ladder from [historical rewrite construction](../../../../docs/fork/operations/fork-sync.md#historical-rewrite-construction); the design-only report is not executable.
Keep every unresolved proof gate explicit, because the constructor refuses it.

Never invent eligibility to get through the gate, and expect no proof relaxation.
Missing outcome evidence needs reviewed reconciliation, not a substituted candidate.

Set `FORK_OUTCOME_EXECUTOR=agent` on operator auto, check, and apply invocations, and publish their retained outcome evidence.
A same-base rewrite is an attempt on the existing target, not an upstream advance or an unattended success.
After it applies, start a fresh tagged report for the actual upstream replay.

## Series rewrite review

The review belongs to the series rewrite, not to the walk.
Hand the emitted report and record paths to a reviewer in another session, who records exactly one result ([series rewrite review](../../../../docs/fork/operations/fork-sync.md#series-rewrite-review)).

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
