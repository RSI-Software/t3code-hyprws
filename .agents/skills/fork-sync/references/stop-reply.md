# Reply shape

The human reads a reply cold: no diff, no report, no lane.
A stop orients them to one decision and asks for one word.
A landing tells them it is done and where the record is.
The report on disk is the record; the reply is not.

## Landing

No stop happened; the walk applied.

```md
**Landed:** `<tag>` on `hyprws` at `<sha>`

- **Rows:** <n> clear, <n> retired, 0 judgement
- **Record:** `<report path>`
- **Friction:** <one line each, or none>
```

Nothing else: no row list, no trace, no prompt.

## Floor

### Scope

- **One** judgement row per reply
- **150 words** max above the fork
- **End** on one prompt
- **Never** paste the decision surface
- **Cite** the report path once

### Register

- **Plain words** first, standard engineering terms
- **Keep** the row's exact entities
- **No** line refs, hunks, or log paste unless asked
- **Visual:** steps, before/after, or tiny table

### Options

- **Max 3**, recommended first
- **One consequence** each
- **Recommendation** is a word the human can echo

## Template

```md
**Stop:** <what halted> on `<tag>`

<frame: 1 to 3 lines, what this is and why it is in front of you>

<visual>

**Options**

1. `<word>` (recommended): <consequence>
2. `<word>`: <consequence>

**Clear:** <n> rows resolved, reasons in `<report path>`
**Friction:** <one line each, or none>

> your call?
```

## Recommendation

A recommendation names the action, not the act of deciding.

```diff
- judgement: recommend you decide the churn reconciliation
+ judgement: reset. local refs/fork/churn to origin, then replay walks 1866, 1948, 1978 by hand
```

- **Both readings** become options, not prose
- **Doubt** picks the reversible option, and says so
- **Never** record it as the decision

## Queue

More than one judgement row is more than one reply.

1. First reply: list the queue, unpack row one
2. Each reply: one row, footer `next: <row> (n/N)`
3. Record nothing until every row has its word
4. Last reply: row and word table, then the go

## Friction

A stop that was not a judgement, or a tool that failed the walk.

- **One line** each, plain words
- **Every** reply carries the line, stop or landing
- **Lodge** it in the notification issue
- **Never** past the reply budget
