# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

`hyprws upstream sync` is the normal operator; a maintainer intervenes only to resolve a block or cut a release by hand.
Discipline lives in [Fork development](../internals/fork-development.md); the procedure lives in the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill.

## Model

`hyprws` is the single fork trunk.
The sync driver runs one upstream release tag end to end: one run, one exit code, one report.

- **Session:** `fork:sync [<tag>]`; rebases only
- **Land:** `fork:sync --land`; the workflow only

A session writes no trunk, candidate, or issue.
`--land` refuses to run unless `GITHUB_ACTIONS=true`.

It never merges upstream in, nor drops a commit; only a `fixup!` moves, beneath its owner.
Without a named tag it targets a valid [marker](#resolution-marker)'s tag the trunk lacks, else the newest stable or nightly tag; `-preview.` tags are skipped on purpose.
It folds each `fixup! <subject>` landing into the one fork commit it names, a squash landing's trailing ` (#N)` included, and refuses a fixup naming none or several.
It rewords only an owner that absorbs a squash-landed fixup: the fixup's PR link joins its `Squashes:` list, rendered the way fork:fold renders one.
The rebase refuses a rebased tip that dropped any PR link, except from a commit the target carries: patch-for-patch, or superseded with every path it touched identical to the target.

| Step    | Does                                           | Fails when               |
| ------- | ---------------------------------------------- | ------------------------ |
| fetch   | `upstream` tags, `origin/hyprws`, the marker   | fetch error              |
| target  | named tag, marker's tag, or newest release     | not a release tag        |
| rebase  | `git rebase -i --autosquash <tag>`             | a seam no resolver fixes |
| carry   | cherry-picks trunk commits since the lease     | a pick conflicts         |
| ci      | land: [candidate CI](#candidate-ci) on the tip | the run is not green     |
| push    | land: `--force-with-lease=hyprws:<lease>`      | lease refused            |
| blocked | land: one attention issue per red run          | `gh` refuses the write   |
| report  | `.t3/fork-sync/<tag>.json`, before any post    |                          |

An applied run cuts the nightly by itself: `hyprws-ci.yml` completion triggers `hyprws-release.yml` through `workflow_run`.
The release gate needs the current `origin/hyprws` tip with a green `hyprws CI` (RSI-Software/t3code-hyprws#1181).

## Candidate CI

The land run pushes the trunk directly, so no pull request runs `hyprws CI` before the push; the candidate branch does.

- **Branch:** `sync/candidate`, force-pushed
- **Ruleset:** none
- **Run:** the full `hyprws CI` push run on that sha
- **Reuse:** a sha with a run reuses it
- **Gate:** new sha passes `vp run fork:ci` first
- **Wait:** returns at the first failed job
- **Red:** no run in 5 minutes, or none in an hour
- **Push:** only the sha the run passed, leased
- **On red:** `hyprws` stays; `ci.jobs` names jobs
- **Scope:** `fork:ci` scans from the new base
- **Skipped:** stale-delete

A candidate replays every fork commit, so stale-delete has nothing new to judge.

`fork-fold` publishes only a tree-equal fold, so it inherits the same guarantee.

## Local trunk

The land run force-pushes `origin/hyprws` under a lease, so `git pull --ff-only` cannot follow it.
Reset local `hyprws` in the canonical checkout, then rerun whatever refused:

```bash
git fetch origin hyprws
git reset --hard origin/hyprws
```

Worktree setup refuses a branch cut from the stale history.

## The report

The typed report (`fork.sync-report.v3`) is the only run authority; the Markdown a run prints is output and never read back.
Issue comments are projections of it: never parse one, and never treat an edit to one as a decision.

| Outcome           | Exit | Run     | Means                                  |
| ----------------- | ---- | ------- | -------------------------------------- |
| `already-applied` | 0    | both    | the trunk contains the tag             |
| `rebased`         | 0    | session | finished marker written                |
| `applied`         | 0    | land    | trunk moved to a green candidate       |
| `blocked`         | 1    | both    | manual seam; partial marker written    |
| `failed`          | 1    | both    | `fetch` through `blocked`; see `error` |

| Field         | Meaning                                   |
| ------------- | ----------------------------------------- |
| `land`        | Whether this was a land run               |
| `target`      | The tag and its sha                       |
| `lease`       | The `origin/hyprws` sha the stack replays |
| `trunk`       | Trunk before and after                    |
| `conflicts[]` | Every stop's path, commits, resolution    |
| `ci`          | The candidate's `hyprws CI` run and jobs  |
| `marker`      | Marker written or read; commits left      |
| `decision`    | Worktree, manual paths, resume, hand-off  |

Decisions persist to the report before any comment posts.
Never edit a report; a rerun supersedes it.

## Automatic resolution

Conflict resolution is machine-owned, in this order.

1. Rerere replays this checkout's earlier resolutions
2. Hook re-apply re-inserts marked hooks
3. A net-zero fork edit takes upstream's delete
4. [Regenerable files](#regenerable-files) regenerate
5. Anything left is `manual` and stops the run

Rerere data stays in the checkout that recorded it; nothing exports it.
Hook re-apply moves the fork side's marked hooks onto the upstream text.
A net-zero fork edit is a path whose fork trunk blob still equals the base blob; the driver accepts its delete with `git rm`.
A regenerable file waits until every other path in the stop resolves.

Only upstream moved: upstream's text stands.
A marked fork hook goes back in verbatim, shifted only when upstream re-indented its anchor.
There is no "upstream superseded this" rule: retirement is a traced verdict written in [fork-delta](../internals/fork-delta.md), never a merge rule.

## Resolution marker

A session hands its tip to the land run as one marker commit, `refs/fork-sync/resolution`, pushed to the `sync/resolution` branch.

- **Parent:** the rebased tip
- **Tree:** the lease's; a push runs trunk workflows
- **Subject:** `fork-sync finished <tag>`
- **Or:** `fork-sync partial <tag>: N commits left`
- **Partial body:** the remaining rebase todo
- **Trailers:** `Fork-Sync-Tag`, `Fork-Sync-Lease`
- **Written:** every rebased or blocked run
- **Unchanged rerun:** reuses the same commit

A marker is ignored, with a printed note and a fresh rebase, when:

- its tag is not the target
- its lease is not in `origin/hyprws`
- its tree is not its lease's
- its tip lacks the target
- its todo names commits outside the stack

Anything else on the branch, such as the old parentless resolution data, is ignored with a note.

**Rerun:** a push to `sync/resolution` runs `hyprws-sync-resolution.yml`, which dispatches `hyprws-upstream-sync.yml` on `hyprws`.
A session pushes it with `git push --force origin refs/fork-sync/resolution:refs/heads/sync/resolution`; rsi-pr-agent pushes the job's `HEAD`.

### The land run

1. Fetch, read the marker, pick the target
2. Trunk has the tag: close stale sync issues
3. Partial marker: issue rewritten as blocked; exit 1
4. Finished marker: worktree at its tip
5. No marker: fresh rebase; a stop is blocked
6. Carry new trunk commits; link guard
7. [Candidate CI](#candidate-ci), then the lease push
8. Close the attention issues

A partial marker's issue names the commits left; the next `vp run fork:sync <tag>` resumes.

## Attention issue lifecycle

Every red land run (blocked or failed) rewrites one standing sync attention issue through plain `gh`, after writing its report.
Its title names the step and target, so reruns never rename it; its body carries conflict and resume details or the failure and red jobs, plus the open-since date, target count, and last five runs.

The newest open `ci` issue matching `hyprws sync blocked` or `hyprws sync failed` is adopted, including legacy issues.
Older matches close with a one-line pointer to the kept issue; only no match files a new one.
A blocked run, or one failed at `ci` or `carry`, also adds `rsi:fork-sync` on create or rewrite, which starts rsi-pr-agent's `fork-sync` workflow; any other failure never does.
An unchanged body never relabels, so no progress starts no new job.
A clean run (applied or already-applied) closes open matches with `gh issue close --reason completed --comment "Resolved by hyprws <sha>"`.
A refused publication or close lands in the report and fails the run.
Sessions never publish or close issues.

Never post a sync issue to `pingdotgg/t3code`.

## Unblocking by hand

The [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill owns the procedure: resolve each path in the kept worktree, `git add`, rerun, hand off.
Never continue the rebase by hand: the rerun continues it, so each later stop still gets every [automatic resolution](#automatic-resolution).

Rerere records nothing for a delete/modify: the fix is a driver rule or a pre-adopt commit on `hyprws` (precedent `72666ffe19`, RSI-Software/t3code-hyprws#1227).

### Reshape

Resolve minimally in the rebase: upstream's text plus marked hooks verbatim.
Adaptation never lands inside a replayed commit; the hook guard (`scripts/lib/fork-hook-guard.ts`, run by `fork:ci`) refuses it.
Commit it at the tip of the kept sync worktree, then rerun so the marker covers it.

- **Owner adaptation:** `fixup! <owner subject>`
- **Its trailers:** the owner's
- **Owner:** newest fork commit on those lines
- **No single owner:** one `upstream-fixes` commit
- **Retirement:** its own commit, never a fixup

The next sync's rebase folds each fixup into its owner, and `fork:ci` proves it folds there, naming the owner when the fixup names the wrong one.
Autosquash discards a fixup's body, so a reason worth keeping goes in its own commit.

### Kept sync worktree

It lives in the main checkout's `.t3/fork-sync/`, as `worktree/` and `worktree.json`, whichever checkout runs the sync.
`vp run fork:sync` first waits for the invoking checkout's own setup, so a fresh lane never races its install.
Created through the `t3.json` setup step, so a stop has dependencies installed; the local gate reinstalls the frozen lockfile first, since the rebase can move it.
It carries every stop's rows between runs, so the report keeps them.

A run starts from the kept worktree, a valid marker, or a fresh rebase, in the skill's [order](../../../.agents/skills/fork-sync/SKILL.md#run).
A moved trunk keeps the lease: the run cherry-picks the new trunk commits onto the finished tip.
A conflicting pick stays stopped in the worktree: resolve, `git add`, rerun.
Delete `worktree.json` to drop the kept worktree and adopt a marker or start fresh.

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
Store it as the `HYPRWS_MIRROR_TOKEN` secret of the `hyprws-sync` environment, which only `hyprws` can deploy to.
A push to `sync/resolution` runs only the marker's tree, the lease's trunk files, so a resolver never reaches the token.
Only its push of `sync/candidate` starts `hyprws CI`; a `GITHUB_TOKEN` push starts no workflow.
The workflow uses its own `GITHUB_TOKEN` with `actions: read` and `issues: write`; never widen the token.

### Which events run the fork matrix

`hyprws-ci.yml` produces every context the `hyprws` ruleset requires: `Check`, `Test`, `Test Scripts`, `Test Web`, `merge-tree`, and three `Test Server` shards.
`hyprws-body.yml` stays advisory: no ruleset requires its `Body` context.
It runs on a pull request opened, pushed to, or reopened, on a push to a fork trunk, release branch, or `sync/candidate`, and on `merge_group`.

It skips `ready_for_review`, already covered on that draft head.
Add the `merge_group` trigger before requiring a queue in the ruleset.

### Upstream workflows and merge settings

Keep only the five `hyprws-*.yml` workflows enabled.
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

- **`hyprws`:** pull request, 0 approvals
- **Its checks:** each `hyprws-ci.yml` context above
- **Its bypass:** admin; no force-push rule
- **`main`:** pull request, same admin bypass
- **`main` writer:** only the mirror
- **`no trunk deletion`:** `hyprws` and `main`
- **Its bypass actors:** none
- **`stable tags`:** `refs/tags/v*-hyprws.*`
- **Excludes:** nightlies
- **Blocks:** tag delete and update

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

- **Mirror fails:** recreate the token
- **Mirror refused:** someone wrote `main`
- **Lease refused:** rerun; it carries new commits
- **Never:** `--force` the trunk or `main`
- **Issue remains:** resolve its stop
- **Candidate red:** fix at the tip in a session
- **Flake:** `gh run rerun --failed`, rerun the sync
- **Stable release fails:** fix and rerun
- **Published tag:** never moved

## Version ordering caveat

Semver precedence is global even though the updater separates channels: `0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2` and promotes nothing.
Never infer channel or recency from a mixed sort; filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
