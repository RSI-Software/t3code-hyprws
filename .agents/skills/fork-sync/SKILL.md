---
name: fork-sync
description: Unblock an RSI-Software/t3code-hyprws upstream rebase with a reported rehearsal and leased apply, or cut a stable fork release from a bot-owned snapshot.
---

# Fork sync

Pick exactly one entry point.

| Entry point    | Does                                  | Reference                              |
| -------------- | ------------------------------------- | -------------------------------------- |
| **Unblock**    | Replays the fork onto an upstream tag | [Unblock](references/unblock.md)       |
| **Cut stable** | Tags a stable release from a snapshot | [Cut stable](references/cut-stable.md) |

Unattended is the default.
A stop must be a judgement; a stop that was not one is friction to lodge.

- **Never** post to `pingdotgg/t3code`
- **Never** merge upstream into `hyprws`
- **Never** move a bot-owned ref by hand
- **Never** edit an emitted report or record
- **Never** bypass a refusal or `fork:sync-gate`

Every report path is external operator state.

The [fork-sync runbook](../../../docs/operations/fork-sync.md) owns the bot model, the ledgers, and recovery.
Read it when something refuses, not before.

## Stop shape

Both entry points stop the same way.
A stop hands a decision to the human; it never takes one.

At a stop, first reproduce the emitted decision surface verbatim and unchanged.
Then write one triage line per decision, in exactly one of these forms:

| Form                      | Line                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Mechanical or unambiguous | `clear: <recommendation>. <one-line reason>`                                        |
| A real choice             | `judgement: <recommendation>. <reading A> vs <reading B>; <why the recommendation>` |

A `judgement` line carries enough context for a reader who has not seen the diff.
Then ask the human's exact word for every decision, and stop.

- **Answer** the whole set, not the first line
- **Continue when:** each decision names its subject
- **And:** the human gives an explicit go
- **Record only** the decisions supplied
- **Never** record a recommendation as a decision
- **Recency** is no permission to choose

## Unblock

Walk one eligible upstream tag onto `hyprws` under an expected-old lease.

```bash
vp run fork:sync unblock-auto [--target tag@sha] [--report <path>]
```

One invocation runs the whole ladder and asks for nothing.
[Unblock](references/unblock.md) owns setup, conflict doctrine, the two legal stops, the review gate, and every manual verb.

## Cut stable

Tag a stable release from a bot-owned snapshot, after a UAT cycle and a human go.

```bash
vp run fork:sync stable-list
vp run fork:sync stable-prepare --report <report> --issue <human-selected-issue>
vp run fork:sync stable-publish --report <report> --go <exact-candidate>
```

The nightly channel needs no entry point: a leased apply cuts it by itself.
[Cut stable](references/cut-stable.md) owns candidate selection, the UAT boundary, and the publication refusals.
