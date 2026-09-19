# Historical fork sync records

This directory preserves rehearsal records from before operational history left the replayed stack.
Do not add, migrate, or delete files here.

New records live outside the repository, and no path commits an operational record to `hyprws`.
See the [fork sync runbook](../fork-sync.md).

| Sync                                                        | Record                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Human rehearsal**                                         | Drafted outside the repository by the [`fork-sync` skill](../../../.agents/skills/fork-sync/SKILL.md), then posted on the current `rebase-blocked` issue after sign-off |
| **Automatic rewrite**                                       | The immutable `hyprws upstream sync` workflow run summary                                                                                                               |
| **Stable cut from an unchanged bot-owned release snapshot** | None: the candidate issue, tag, workflow run, and release are that cut's record                                                                                         |

## Historical human syncs

| Release     | Records                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stable**  | [`v0.0.34`](./v0.0.34.md), [`v0.0.35`](./v0.0.35.md), [`v0.0.36`](./v0.0.36.md)                                                                                                                                                                                                            |
| **Nightly** | [`v0.0.37-nightly.20260829.1217`](./v0.0.37-nightly.20260829.1217.md), [`v0.0.37-nightly.20260829.1224`](./v0.0.37-nightly.20260829.1224.md), [`v0.0.37-nightly.20260830.1226`](./v0.0.37-nightly.20260830.1226.md), [`v0.0.37-nightly.20260830.1227`](./v0.0.37-nightly.20260830.1227.md) |
