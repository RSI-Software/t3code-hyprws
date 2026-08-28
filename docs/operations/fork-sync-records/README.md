# Fork sync records

This directory contains durable evidence for **human-run** fork sync rehearsals. A record captures the
selected upstream tag, expected-old lease, conflicts and automerged overlap, fork decisions, focused
checks, grounding, and human sanity approval.

Automatic bot rewrites do not add a record commit to `hyprws`. Their immutable evidence is the
`hyprws rebase report` workflow run summary: source and target refs, mode, replay verification,
stable snapshots, pushes, and any next conflict. See the [fork sync runbook](../fork-sync.md#reading-a-bot-run).

Keep existing records and add a new `<target-tag>.md` record whenever a maintainer uses the
[`fork-sync` skill](../../../.agents/skills/fork-sync/SKILL.md) to resolve a block or otherwise
performs a human sync. Cutting a stable tag from an unchanged bot-owned release snapshot is not a
human sync and does not add a file here; the candidate issue, tag, workflow run, and release are that
cut's record.

## Recorded human syncs

- [`v0.0.34`](./v0.0.34.md)
- [`v0.0.35`](./v0.0.35.md)
