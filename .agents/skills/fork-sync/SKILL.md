---
name: fork-sync
description: Unblock an RSI-Software/t3code-hyprws upstream rebase with a reported rehearsal and leased apply, or cut a stable fork release from a bot-owned snapshot.
---

# Fork sync

Pick exactly one entry point, and never ask which.

| Entry point    | When                                 | Reference                              |
| -------------- | ------------------------------------ | -------------------------------------- |
| **Unblock**    | Default: bare invocation, or "sync"  | [Unblock](references/unblock.md)       |
| **Cut stable** | Only when the ask names a stable cut | [Cut stable](references/cut-stable.md) |

**Goal:** the fork stays in sync with upstream unattended.
One invocation walks to the end; you judge, the human does not.
A stop is a doubt you could not trace away, and nothing else.

### Never

- **Post** to `pingdotgg/t3code`
- **Merge** upstream into `hyprws`
- **Move** a bot-owned ref by hand
- **Bypass** a refusal
- **Hand** the human a fault as a decision
- **Redo** by hand what a verb does

### Reports

- **Never** edit an emitted report or its published record
- **Decide** a declined row with `record-decisions --input <json>`
- **Record:** a projection only; editing it authorizes nothing
- **Every** report path is external operator state

The [fork-sync runbook](../../../docs/fork/operations/fork-sync.md) owns the bot model, the ledgers, and recovery.
Read it when something refuses, not before.

## Stop shape

Both entry points triage the same way.
Triage is not a stop: only a `judgement` row stops the walk.

At a handback, triage every row in the report, one line each:

| Row class                               | Triage      | Then                     |
| --------------------------------------- | ----------- | ------------------------ |
| `generated`, `mechanical`, `seam-moved` | `clear`     | Resolve it and continue  |
| `retire-candidate`                      | `clear`     | Trace, verdict, continue |
| `human`                                 | `clear`     | Trace intent, resolve    |
| any, after tracing left doubt           | `judgement` | Stop for the human       |

```text
clear:     <resolution>. <one-line reason>
judgement: <recommended word>. <reading A> vs <reading B>; <why>
```

The decision surface stays in the report; the reply never reproduces it.

### Fault

A halt that is not a row is a fault: a ref diverged, a verb crashed, a lane cannot test.
Repair it under the runbook, then rerun the verb; never hand-replay its work.
Note the friction as one line in the landing reply.

- **Ref diverged:** origin wins, refetch
- **Then:** re-append rows from retained reports
- **Verb crashed:** file the bug, walk on by hand
- **Lane cannot test:** repair, rerun
- **Never** turn a fault into a `judgement`

### Clear

`clear` means no human is needed, so never ask for one.
Resolve the row, record the reason in the report, and keep walking.

An executor handback is a row the machine could not take, not a refusal of you.
Triage it like any other row; `clear` there is yours to resolve.

- **Test:** one resolution compiles, others do not
- **Or:** both sides are additive and both used
- **Or:** the trace names intent, one side serves it
- **Doubt** after tracing makes it `judgement`
- **Never** widen `clear` to dodge a stop

#### Trace

Before any `judgement`, trace the row, and record what you found.

1. Fork commit: message, trailers, domain, behaviour
2. Upstream hunk: what it adds, removes, or moves
3. Same shape upstream, or only a name sighting?
4. Verdict: `retire`, `keep`, `keep-both`, `reapply`
5. Doubt left? Say which step, and stop there

### Judgement

Stop only once a `judgement` row exists.
Reply by the [reply shape](references/stop-reply.md): one row, one visual, ranked options, one prompt.
A landing uses the same file's landing template.
The human has not seen the diff, the report, or the lane.

#### Ask

- **Recommend** a word the human can echo
- **Answer** every judgement row, one reply each
- **Continue when:** each names its subject
- **And:** the human gives an explicit go

#### Record

- **Only** the decisions supplied
- **Never** a recommendation as a decision
- **Recency** is no permission to choose

## Unblock

Walk one eligible upstream tag onto `hyprws` under an expected-old lease.

```bash
vp run fork:sync unblock-auto [--target tag@sha] [--report <path>]
```

One invocation runs the whole ladder and asks for nothing.
[Unblock](references/unblock.md) owns setup, conflict doctrine, the two legal stops, the review gate, and every manual verb.

## Cut stable

Tag a stable release from a bot-owned snapshot, after a human go.

```bash
vp run fork:sync stable-list
vp run fork:sync stable-prepare --report <report> --issue <human-selected-issue>
vp run fork:sync stable-publish --report <report> --go <exact-candidate>
```

The nightly channel needs no entry point: a leased apply cuts it by itself.
[Cut stable](references/cut-stable.md) owns candidate selection and the publication refusals.
