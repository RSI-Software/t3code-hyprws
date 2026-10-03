# Historical fork sync records

This directory preserves rehearsal records created before operational history moved out of the
replayed stack. Do not add new records here and do not migrate or delete the existing files.

For a new human rehearsal, the
[`fork-sync` skill](../../../.agents/skills/fork-sync/SKILL.md) drafts the record outside the
repository and posts it as a comment on the current `rebase-blocked` issue after sign-off. Automatic
rewrites use the immutable `hyprws upstream sync` workflow run summary. Neither path adds an
operational record commit to `hyprws`; see the [fork sync runbook](../fork-sync.md).

Cutting a stable tag from an unchanged bot-owned release snapshot creates no rehearsal record. The
candidate issue, tag, workflow run, and release are that cut's record.

## Historical human syncs

- [`v0.0.34`](./v0.0.34.md)
- [`v0.0.35`](./v0.0.35.md)
- [`v0.0.36`](./v0.0.36.md)
- [`v0.0.37-nightly.20260829.1217`](./v0.0.37-nightly.20260829.1217.md)
- [`v0.0.37-nightly.20260829.1224`](./v0.0.37-nightly.20260829.1224.md)
- [`v0.0.37-nightly.20260830.1226`](./v0.0.37-nightly.20260830.1226.md)
- [`v0.0.37-nightly.20260830.1227`](./v0.0.37-nightly.20260830.1227.md)
