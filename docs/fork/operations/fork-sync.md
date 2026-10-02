# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

`hyprws upstream sync` is the normal operator; a maintainer intervenes only to resolve a block or cut a release by hand.
Discipline lives in [Fork development](../internals/fork-development.md); the procedure lives in the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill.

## Model

`hyprws` is the single fork trunk.
The sync driver runs one upstream release tag end to end: one run, one exit code, one report.
It never merges upstream in, nor drops, reorders, or rewords a commit.
It folds each `fixup! <subject>` landing into the one fork commit it names, and refuses a fixup naming none or several.

| Step    | Does                                                                      | Fails when                                         |
| ------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| target  | the named tag, or the newest release tag on `upstream`                    | the target is not a release tag                    |
| fetch   | `git fetch --tags upstream`, `git fetch origin hyprws`                    | fetch error                                        |
| rebase  | detached worktree, `git rebase -i --autosquash --rerere-autoupdate <tag>` | a conflict rerere and hook re-apply cannot resolve |
| check   | the [check battery](#check-battery), in the worktree                      | any red                                            |
| push    | `--force-with-lease=hyprws:<fetched sha>`                                 | lease refused                                      |
| blocked | one standing block issue, rewritten per run, through `gh`                 | `gh` refuses the write                             |
| report  | `.t3/fork-sync/<tag>.json`, typed, written before any post                |                                                    |

A tag the fork already sits on reports `already applied`, after closing any open block or failure issue.
`--dry-run` rebases and checks, then stops: no push, no issue, no close.
An applied run cuts the nightly by itself: `hyprws-ci.yml` completion triggers `hyprws-release.yml` through `workflow_run`.
The release gate needs the current `origin/hyprws` tip with a green `hyprws CI`; a red battery cuts no release (RSI-Software/t3code-hyprws#1181).

## Check battery

A sync pushes the trunk directly, so no pull request runs `hyprws CI` before the push; the battery does.

| Rule      | Contract                                                          |
| --------- | ----------------------------------------------------------------- |
| Check job | `fork:delta --check`, `fork:ci`, then the Check job's own steps   |
| Test jobs | every `test*` job in `hyprws-ci.yml`, one row per matrix cell     |
| Derived   | read from the replayed workflow; an unreadable step stops the run |
| No skip   | no flag drops a row                                               |
| Push      | only when every row is green; a red row leaves `hyprws` unmoved   |
| Report    | each row names its CI job; the run's error lists every red one    |
| Env       | umask `022`; no `T3_*` or `T3CODE_*` variable reaches a check     |

`fork-fold` publishes only a tree-equal fold, so it inherits the same guarantee.

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
Issue comments are projections of it: never parse one, and never treat an edit to one as a decision.

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
| 4   | Anything left is a `manual` row and stops the run                                                                              |

Only upstream moved: upstream's text stands.
A marked fork hook goes back in verbatim.
There is no "upstream superseded this" rule: retirement is a traced verdict written in [fork-delta](../internals/fork-delta.md), never a merge rule.

## Block lifecycle

A blocked run writes its report first, then rewrites the one open block issue through plain `gh`, filing it only when none is open.
The body carries the conflict table (path, fork commit, upstream commit), the resume commands, and a tail: open-since date, target count, last five runs.

| Rule     | Detail                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity | Title phrase `hyprws sync blocked` and the governed `ci` label, no sync-specific label; the newest open issue is the standing one                                                                    |
| Standing | Each blocked run rewrites its title and body; older open block issues close as superseded                                                                                                            |
| Close    | A clean run (applied or already-applied) closes each open block issue with `gh issue close --reason completed --comment "Resolved by hyprws <sha>"`; a refusal lands in the report and fails the run |
| Route    | Plain `gh` only                                                                                                                                                                                      |
| Refusal  | A refusing `gh` prints the body; the run exits non-zero                                                                                                                                              |

Never post a block to `pingdotgg/t3code`.

### Unblocking by hand

1. Read `decision`: worktree, paths, resume commands.
2. Open that worktree.
3. Resolve per [the rule](#automatic-resolution).
4. `git add` the resolved paths.
5. `git rebase --continue`.
6. Rerun `vp run fork:sync <tag>`.

Rerere replays content resolutions but records nothing for a delete/modify: the fix is a driver rule or a pre-adopt commit on `hyprws` (precedent `72666ffe19`, RSI-Software/t3code-hyprws#1227).

**Reshape.** Resolve minimally in the rebase: upstream's text plus marked hooks verbatim.
Adaptation never lands inside a replayed commit; the hook guard (`scripts/lib/fork-hook-guard.ts`, run by `fork:ci`) refuses it.
Commit it once, as one `Fork-Repair` commit at the tip of the kept sync worktree; a rerun on the same tag and lease adopts it.
After the sync, the [`fork-fold`](../../../.agents/skills/fork-fold/SKILL.md) repair split dissolves it into its owners.

## Failure lifecycle

A run that fails on a non-blocked step (target, fetch, rebase, check, push, or a crash) rewrites one standing failure issue the same way a block does, through the same `gh` route.

| Rule     | Detail                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity | Title phrase `hyprws sync failed` and label `ci`; the newest open issue is the standing one                                                                              |
| Standing | Each failed run rewrites its title and body; a dry run reports and never files                                                                                           |
| Close    | A clean run (applied or already-applied) closes it in the same `gh issue close --comment` pass that closes block issues; a refusal lands in the report and fails the run |

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
