# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

`hyprws upstream sync` is the normal operator; a maintainer intervenes only to resolve a block or cut a release by hand.
Discipline lives in [Fork development](../internals/fork-development.md); the procedure lives in the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill.

## Model

`hyprws` is the single fork trunk.
The sync driver runs one upstream release tag end to end: one run, one exit code, one report.
It never merges upstream in, nor drops a commit; only a `fixup!` moves, beneath its owner.
Without a named tag it targets the newest stable or nightly tag; `-preview.` tags are skipped on purpose.
It folds each `fixup! <subject>` landing into the one fork commit it names, a squash landing's trailing ` (#N)` included, and refuses a fixup naming none or several.
It rewords only an owner that absorbs a squash-landed fixup: the fixup's PR link joins its `Squashes:` list, rendered the way fork:fold renders one.
The rebase refuses a rebased tip that dropped any PR link, except from a commit the target carries: patch-for-patch, or superseded with every path it touched identical to the target.

| Step    | Does                                                                      | Fails when                                         |
| ------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| target  | the named tag, or the newest release tag on `upstream`                    | the target is not a release tag                    |
| fetch   | `git fetch --tags --force upstream`, `git fetch origin hyprws`            | fetch error                                        |
| rebase  | detached worktree, `git rebase -i --autosquash --rerere-autoupdate <tag>` | a conflict rerere and hook re-apply cannot resolve |
| ci      | [candidate CI](#candidate-ci) on the rebased tip                          | the run is not green                               |
| push    | `--force-with-lease=hyprws:<fetched sha>`                                 | lease refused                                      |
| blocked | one attention issue for any red run, via `gh`                             | `gh` refuses the write                             |
| report  | the main checkout's `.t3/fork-sync/<tag>.json`, typed, before any post    |                                                    |

A tag the fork already sits on reports `already applied`, after closing the open sync attention issue.
`--dry-run` rebases and runs candidate CI, then stops: no trunk push, no issue, no close.
A green dry run keeps its tip in the [sync worktree](#unblocking-by-hand); `decision.tip` names it.
The real run on the same tag and lease adopts that tip, reuses its green run, and pushes it, with no second rebase.
An applied run cuts the nightly by itself: `hyprws-ci.yml` completion triggers `hyprws-release.yml` through `workflow_run`.
The release gate needs the current `origin/hyprws` tip with a green `hyprws CI` (RSI-Software/t3code-hyprws#1181).

## Candidate CI

A sync pushes the trunk directly, so no pull request runs `hyprws CI` before the push; the candidate branch does.

| Rule   | Contract                                                 |
| ------ | -------------------------------------------------------- |
| Branch | `sync/candidate`, force-pushed with the tip; unprotected |
| Run    | the full `hyprws CI` push run on that sha                |
| Reuse  | a sha that already has a run reuses it; no second push   |
| Gate   | a new sha passes local `vp run fork:ci` before its push  |
| Wait   | returns at the first failed job                          |
| Limit  | no run in 5 minutes, or none ending in an hour, is red   |
| Push   | only the sha the run passed, under the lease             |
| Red    | `hyprws` stays put; `ci.jobs` names each red job         |
| Scope  | `fork:ci` scans from the new base and skips stale-delete |

A candidate replays every fork commit, so stale-delete has nothing new to judge.

`fork-fold` publishes only a tree-equal fold, so it inherits the same guarantee.

## Local trunk

A run publishes the rebased stack by force push to `origin/hyprws` under a lease.
After the push, local `hyprws` moves to the new tip when it still sits at the lease and its checkout has no tracked changes (`git reset --keep`).
Otherwise the run prints why it kept the branch; `git pull --ff-only` cannot follow a rewrite.
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
| `conflicts[]` | Every stop's path, fork and upstream commit, resolution    |
| `ci`          | The candidate's `hyprws CI` run, conclusion, and jobs      |
| `decision`    | A blocked run's or kept tip's worktree, paths, and resume  |

Decisions persist to the report before any comment posts.
Never edit a report; a rerun supersedes it.

## Automatic resolution

Conflict resolution is machine-owned, in this order.

| #   | Rule                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Rerere replays resolutions from the run's rebase and [`sync/resolution`](#resolution-data), and stages them                    |
| 2   | Hook re-apply re-inserts the marked fork hooks a conflicted file declares, from the fork side onto the upstream text           |
| 3   | An upstream delete of a path whose fork trunk blob still equals the base blob (a net-zero fork edit) is accepted with `git rm` |
| 4   | A [regenerable file](#regenerable-files) regenerates once every other path in the stop resolves                                |
| 5   | Anything left is a `manual` row and stops the run                                                                              |

Only upstream moved: upstream's text stands.
A marked fork hook goes back in verbatim, shifted only when upstream re-indented its anchor.
There is no "upstream superseded this" rule: retirement is a traced verdict written in [fork-delta](../internals/fork-delta.md), never a merge rule.

## Resolution data

Every CI run starts on a fresh runner, so `.git/rr-cache` and tip fixups die with it.
The driver keeps them as git data instead.

- **Export:** `refs/fork-sync/resolution`, per rebase
- **Shape:** one parentless commit, no workflows
- **Contents:** resolved rerere, `fixups.mbox`
- **Scope:** this sync's stops and every import
- **Push:** rsi-pr-agent or a hand resolver
- **Import:** each run, before the rebase
- **Rerere:** joins rr-cache, never replacing
- **Fixups:** `git am --3way` atop a fresh rebase
- **Fixup gate:** `Fork-Sync-Tag` is the target
- **Kept worktree:** its own tip work wins
- **Carry plus fixups:** refuses the run
- **Refusal:** any other path fails the run

The driver reads the branch as data only; nothing on it executes.
The [job mode](../../../.agents/skills/fork-sync/SKILL.md#job-mode) runbook produces it.

## Attention issue lifecycle

Every red run (blocked or failed) rewrites one standing sync attention issue through plain `gh`, after writing its report.
Its title names the step and target, so reruns never rename it; its body carries conflict and resume details or the failure and red jobs, plus the open-since date, target count, and last five runs.

The newest open `ci` issue matching `hyprws sync blocked` or `hyprws sync failed` is adopted, including legacy issues.
Older matches close with a one-line pointer to the kept issue; only no match files a new one.
A clean run (applied or already-applied) closes open matches with `gh issue close --reason completed --comment "Resolved by hyprws <sha>"`.
A refused publication or close lands in the report and fails the run.
Dry runs never publish or close issues.

Never post a sync issue to `pingdotgg/t3code`.

### Unblocking by hand

1. Read `decision`: worktree, paths, resume commands.
2. Open that worktree.
3. Resolve per [the rule](#automatic-resolution).
4. `git add` the resolved paths.
5. Rerun `vp run fork:sync <tag>`.

Never continue the rebase by hand: the rerun continues it, so each later stop still gets every [automatic resolution](#automatic-resolution).

Rerere replays content resolutions but records nothing for a delete/modify: the fix is a driver rule or a pre-adopt commit on `hyprws` (precedent `72666ffe19`, RSI-Software/t3code-hyprws#1227).

**Reshape.** Resolve minimally in the rebase: upstream's text plus marked hooks verbatim.
Adaptation never lands inside a replayed commit; the hook guard (`scripts/lib/fork-hook-guard.ts`, run by `fork:ci`) refuses it.
Commit it at the tip of the kept sync worktree; a rerun on the same tag and lease adopts it.

| Change           | Commit                                                   |
| ---------------- | -------------------------------------------------------- |
| Owner adaptation | `fixup! <owner subject>` with the owner's trailers       |
| Owner            | the newest fork commit touching those lines              |
| No single owner  | one standalone `upstream-fixes` commit naming the change |
| Retirement       | its own commit, never inside a fixup body                |

The next sync's rebase folds each fixup into its owner, and `fork:ci` proves it folds there, naming the owner when the fixup names the wrong one.
Autosquash discards a fixup's body, so a reason worth keeping goes in its own commit.

**Kept sync worktree.** Lives in the main checkout's `.t3/fork-sync`, whichever checkout runs the sync.
`vp run fork:sync` first waits for the invoking checkout's own setup, so a fresh lane never races its install.
Created through the `t3.json` setup step, so a stop has dependencies installed; the local gate reinstalls the frozen lockfile first, since the rebase can move it.
It carries every stop's rows between runs, so the report keeps them.
A red candidate, a green dry run, or a refused push keeps it, so its tip and tip fixups reach the next run.
A new tag or moved lease rebases from scratch, then cherry-picks the old tip commits onto it.
`refs/fork-sync/carry/*` holds them until they land, so a failed setup or killed run loses none.
A conflicting pick stays stopped in the worktree: resolve, `git add`, rerun.
Rerun after each stop: the report records only the stops a run saw.

## Regenerable files

On a conflict, the driver resolves each path and stages the result, in table order.
A generator reruns over the resolved sources, from the path's `HEAD` copy.
The package-name merge keeps both sides' entries: upstream's order, then the fork's additions.
A failed resolver leaves a `manual` row naming the failure.

| Path                               | Resolver                            | Runs from                    |
| ---------------------------------- | ----------------------------------- | ---------------------------- |
| `pnpm-lock.yaml`                   | `vp install --lockfile-only`        | The sync worktree            |
| `third-party-licenses.config.json` | merge by package name               | The driver, then `vp fmt`    |
| `apps/web/src/routeTree.gen.ts`    | `vp run fork:regenerate-route-tree` | The trunk checkout's install |

`REGENERATION_ROUTES` in `scripts/fork-sync.ts` owns the rows; a test fails when this table drifts from it, or when the fork carries a generated path neither routes.

On a branch that changes a package manifest, regenerate the lockfile before pushing, so a hand-merged lockfile fails there instead of costing a sync run.

## Reading a bot run

```bash
gh run list --workflow hyprws-upstream-sync.yml --limit 1 -R RSI-Software/t3code-hyprws
gh run view <run-id> [--log-failed] -R RSI-Software/t3code-hyprws
```

The **Sync** job summary carries the run's rendered report.
Conflict tables live in the attention issue.

## One-time repository setup

### Bot token

Create a fine-grained token owned by the automation actor, scoped to this repository, with read-and-write **Contents** and **Workflows**.
Store it as the `HYPRWS_MIRROR_TOKEN` Actions secret.
Only its push of `sync/candidate` starts `hyprws CI`; a `GITHUB_TOKEN` push starts no workflow.
The workflow uses its own `GITHUB_TOKEN` with `actions: read` and `issues: write`; never widen the token.

### Which events run the fork matrix

`hyprws-ci.yml` produces every context the `hyprws` ruleset requires: `Check`, `Test`, `Test Scripts`, `Test Web`, `merge-tree`, and three `Test Server` shards.
`hyprws-body.yml` stays advisory: no ruleset requires its `Body` context.
It runs on a pull request opened, pushed to, or reopened, on a push to a fork trunk, release branch, or `sync/candidate`, and on `merge_group`.

It skips `ready_for_review`, already covered on that draft head.
Add the `merge_group` trigger before requiring a queue in the ruleset.

### Upstream workflows and merge settings

Keep only the four `hyprws-*.yml` workflows enabled.
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

| Ruleset             | Targets and rules                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `hyprws`            | Pull request, 0 approvals, plus every `hyprws-ci.yml` context above. Admin bypass, no force-push rule |
| `main`              | Pull request, same admin bypass. Only the mirror writes it                                            |
| `no trunk deletion` | Blocks deleting `hyprws` and `main`, no bypass actors                                                 |
| `stable tags`       | `refs/tags/v*-hyprws.*`, excluding nightlies. Blocks delete and update                                |

### Runners

Every fork workflow runs on `ubuntu-latest`.
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

| Failure                     | Response                                                     |
| --------------------------- | ------------------------------------------------------------ |
| **Mirror fails**            | Recreate the token. Someone wrote `main`; never force        |
| **Trunk lease rejected**    | Rerun; tip commits carry over; never `--force`               |
| **Attention issue remains** | Resolve the reported stop; green closes it                   |
| **Candidate CI red**        | Fix in the kept worktree, or `gh run rerun --failed` a flake |
| **Stable release fails**    | Fix and rerun. Never move a published tag                    |

## Version ordering caveat

Semver precedence is global even though the updater separates channels: `0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2` and promotes nothing.
Never infer channel or recency from a mixed sort; filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
