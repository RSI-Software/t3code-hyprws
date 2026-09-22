# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

`hyprws upstream sync` is the normal operator; a maintainer intervenes only to resolve a block or cut a release by hand.
Discipline lives in [Fork development](../internals/fork-development.md); the procedure lives in the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill.

## Model

`hyprws` is the single fork trunk.
The sync driver runs one upstream release tag end to end; it never merges upstream in, nor drops, squashes, reorders, or rewords a commit.
There is no state machine, no gates, no lanes, no modes: one run, one exit code, one report.

| Step    | Does                                                              | Fails when                                         |
| ------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| target  | the named tag, or the newest release tag on `upstream`            | the target is not a release tag                    |
| fetch   | `git fetch --tags upstream`, `git fetch origin hyprws`            | fetch error                                        |
| rebase  | detached worktree, `git rebase --rerere-autoupdate <tag>`         | a conflict rerere and hook re-apply cannot resolve |
| check   | `fork:delta --check`, `fork:ci`, `vpr typecheck`, in the worktree | any red                                            |
| push    | `--force-with-lease=hyprws:<fetched sha>`                         | lease refused                                      |
| blocked | one block issue per blocking sha, through `ghb`                   | `ghb` refuses and `gh` cannot post                 |
| report  | `.t3/fork-sync/<tag>.json`, typed, written before any post        |                                                    |

A tag the fork already sits on reports `already applied` — after closing the block issues a previous run left open.
`--dry-run` rebases and checks, then stops: no push, no issue, no close.
Every push triggers `hyprws-release.yml`, so an applied run cuts the nightly by itself — once the release gate opens: the release sha is the current `origin/hyprws` tip and that sha carries a green `hyprws CI` conclusion. A red battery cuts no release (RSI-Software/t3code-hyprws#1181).

## Local trunk

A run publishes the rebased stack by force push to `origin/hyprws` under a lease; local clones see the rewrite only after `git fetch origin hyprws`.
The local `hyprws` cannot follow a rewrite: `git pull --ff-only` refuses and leaves the stale branch in place.
Reset it in the canonical checkout, then rerun whatever refused:

```bash
git fetch origin hyprws
git reset --hard origin/hyprws
```

Worktree setup refuses a branch cut from the stale history.

## The report

The typed report is the only run authority; the Markdown a run prints is output and never read back.

| Field         | Meaning                                                    |
| ------------- | ---------------------------------------------------------- |
| `outcome`     | `applied`, `already-applied`, `blocked`, or `failed`       |
| `target`      | The tag and its sha                                        |
| `lease`       | The fetched `origin/hyprws` sha the push is leased against |
| `trunk`       | Trunk before and after                                     |
| `conflicts[]` | Path, fork commit, upstream commit, how the row resolved   |
| `checks[]`    | The check battery and each verdict                         |
| `decision`    | A blocked run's worktree, paths, and resume commands       |

Decisions persist to the report before any comment posts.
Never edit a report; a rerun supersedes it.

## Automatic resolution

Conflict resolution is machine-owned, in this order.

| #   | Rule                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Local rerere replays resolutions within the run's rebase and stages them                                                       |
| 2   | Hook re-apply re-inserts the marked fork hooks a conflicted file declares, from the fork side onto the upstream text           |
| 3   | An upstream delete of a path whose fork trunk blob still equals the base blob (a net-zero fork edit) is accepted with `git rm` |
| 4   | Anything left is a `human` row and stops the run                                                                               |

Only upstream moved: upstream's text stands.
A marked fork hook goes back in verbatim.
There is no "upstream superseded this" rule: retirement is a traced verdict written in [fork-delta](../internals/fork-delta.md), never a merge rule.

## Block lifecycle

A blocked run writes its report first, then files one issue per blocking upstream sha through `ghb`; on a runner without `ghb`, the same write falls back to bare `gh`.
The title phrase and the sha key the issue; the body carries the conflict table (path, fork commit, upstream commit) and the resume commands.

| Rule       | Detail                                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity   | Title phrase `hyprws sync blocked`, label `ci`, and the exact `blocking-sha` body marker                                                                                                                                                                                               |
| Filed once | Per blocking SHA, including after a manual close                                                                                                                                                                                                                                       |
| Rerun      | Same sha updates the issue; a clean run closes it                                                                                                                                                                                                                                      |
| Close      | A clean run (applied or already-applied) claims each open block issue — judged Standalone 📍, since the driver files parentless with `--no-project` — posts the attested `Resolved by hyprws <sha>` comment, then closes it completed; a refusal lands in the report and fails the run |
| Route      | `ghb`; when it cannot spawn (CI), bare `gh`                                                                                                                                                                                                                                            |
| Refusal    | A refusing `ghb` prints the body; the run exits non-zero                                                                                                                                                                                                                               |

Never post a block to `pingdotgg/t3code`, and never use `gh` to route around a `ghb` refusal: `gh` is the no-`ghb` fallback only.

### Unblocking by hand

1. Read `decision`: worktree, paths, resume commands.
2. Open that worktree.
3. Resolve per [the rule](#automatic-resolution).
4. `git add` the resolved paths.
5. `git rebase --continue`.
6. Rerun `vp run fork:sync <tag>`.

Rerere replays content resolutions but records nothing for a delete/modify: the fix is a driver rule or a pre-adopt commit on `hyprws` (precedent `72666ffe19`, RSI-Software/t3code-hyprws#1227).

## Failure lifecycle

A run that fails on a non-blocked step — target, fetch, rebase, check, push, or a crash — files one issue the same way a block does, through the same `ghb`/`gh` route.

| Rule       | Detail                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity   | Title phrase `hyprws sync failed`, label `ci`, and the `sync-failure:<step>:<key>` body marker                                                                   |
| Key        | The failing step plus the target tag, or the trunk sha before a tag resolved                                                                                     |
| Filed once | Per key, including after a manual close                                                                                                                          |
| Rerun      | The same failure updates the issue; a dry run reports and never files                                                                                            |
| Close      | A clean run (applied or already-applied) closes it in the claim → comment → close pass that closes block issues; a refusal lands in the report and fails the run |

## Regenerable files

A sync keeps the new base's version and reruns the generator after applying fork source inputs.

| Path             | Generator                    | Rebase rule                                                       |
| ---------------- | ---------------------------- | ----------------------------------------------------------------- |
| `pnpm-lock.yaml` | `vp install --lockfile-only` | Restore from `HEAD`, resolve sources, regenerate, stage, continue |

On a branch that changes a package manifest, regenerate the lockfile before pushing, so a hand-merged lockfile fails there instead of costing a sync run.

## Reading a bot run

```bash
gh run list --workflow hyprws-upstream-sync.yml --limit 1 -R RSI-Software/t3code-hyprws
gh run view <run-id> [--log-failed] -R RSI-Software/t3code-hyprws
```

The **Sync** job summary carries the run's rendered report.
Conflict tables live in the block issue.

## One-time repository setup

### Bot token

Create a fine-grained token owned by the automation actor, scoped to this repository, with read-and-write **Contents** and **Workflows**.
Store it as the `HYPRWS_MIRROR_TOKEN` Actions secret.
The workflow uses its own `GITHUB_TOKEN` with `issues: write`; never widen the token.

### Labels

Block issues carry the governed `ci` label; nothing creates a sync-specific label.
They are found by the title phrase `hyprws sync blocked` and the `blocking-sha` body marker.

### Which events run the fork matrix

`hyprws-ci.yml` produces every context the `hyprws` ruleset requires: `Check`, `Test`, `Test Scripts`, and three `Test Server` shards.
It runs on a pull request opened, pushed to, or reopened, on a push to a fork trunk or release branch, and on `merge_group`.

It skips `ready_for_review`, already covered on that draft head.
Add the `merge_group` trigger before requiring a queue in the ruleset.

### Upstream workflows and merge settings

Keep only `hyprws-ci.yml`, `hyprws-release.yml`, and `hyprws-upstream-sync.yml` enabled.
Disable every other workflow with `gh workflow disable`; they expect upstream secrets and runners.

```bash
gh repo edit RSI-Software/t3code-hyprws \
  --enable-squash-merge --enable-rebase-merge=false --enable-merge-commit=false \
  --delete-branch-on-merge
gh api -X PATCH repos/RSI-Software/t3code-hyprws \
  -f squash_merge_commit_title=COMMIT_OR_PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES
```

### Applied rulesets

Applied by hand in **Settings > Rules > Rulesets**, all `active`; nothing changes them unattended.

| Ruleset             | Targets and rules                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `hyprws`            | Pull request, 0 approvals, plus `Check`, `Test`, three `Test Server`. Admin bypass, no force-push rule |
| `main`              | Pull request, same admin bypass. Only the mirror writes it                                             |
| `no trunk deletion` | Blocks deleting `hyprws` and `main`, no bypass actors                                                  |
| `stable tags`       | `refs/tags/v*-hyprws.*`, excluding nightlies. Blocks delete and update                                 |

### Runners

Both fork workflows run on `ubuntu-latest`.
`hyprws-release.yml` publishes a nightly on every trunk landing that passes the release gate (trunk tip plus green `hyprws CI`), with a six-hour fallback schedule.
It keeps the newest 7 nightlies and deletes older ones with their tags; stable is never pruned.
Stable fork releases are tagged by hand; `hyprws-release.yml` owns the build either way.

| Tool             | Source                                       |
| ---------------- | -------------------------------------------- |
| Node and `vp`    | `voidzero-dev/setup-vp@v1`, workspace cache  |
| Rust and `cargo` | `dtolnay/rust-toolchain@stable`, runner home |
| ImageMagick      | On the hosted image; `apt-get` when missing  |

A missing tool is a workflow task, never a reason to patch the build script.

### Optional T3 Connect config

T3 Connect stays dark unless all four repository variables exist:

- **`T3CODE_RELAY_URL`**
- **`T3CODE_CLERK_PUBLISHABLE_KEY`**
- **`T3CODE_CLERK_JWT_TEMPLATE`**
- **`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`**

## Failure handling

| Failure                     | Response                                                         |
| --------------------------- | ---------------------------------------------------------------- |
| **Mirror fails**            | Recreate the token. Someone wrote `main`; never force            |
| **Trunk lease rejected**    | Inspect and rerun; never swap in `--force`                       |
| **A blocked issue remains** | Unblock by hand. Retirement needs a traced decision              |
| **A failure issue remains** | Inspect the report, fix, and rerun; the next clean run closes it |
| **Check battery red**       | Fix by pull request; never weaken a check                        |
| **Stable release fails**    | Fix and rerun. Never move a published tag                        |

## Version ordering caveat

Semver precedence is global even though the updater separates channels: `0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2` and promotes nothing.
Never infer channel or recency from a mixed sort; filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
