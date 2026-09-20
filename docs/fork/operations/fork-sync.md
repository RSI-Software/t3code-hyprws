# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

`hyprws upstream sync` is the normal operator; a maintainer intervenes only to resolve a block, enable trunk rewrites, or cut a stable release.
Discipline lives in [Fork development](../internals/fork-development.md); gated procedures in the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill.

## Model

`hyprws` is the single fork trunk, and the bot scans to the newest stable or nightly tag on the first-parent lane, never an untagged head.
It never merges upstream in, nor drops, squashes, reorders, or rewords a commit.

| #   | Step per run                                 |
| --- | -------------------------------------------- |
| 1   | Fast-forward the `main` mirror               |
| 2   | Pick the newest clean tag in the horizon     |
| 3   | Snapshot every stable tag its walk crosses   |
| 4   | Replay and verify the whole stack            |
| 5   | Publish per `HYPRWS_AUTO_REBASE`             |
| 6   | Upsert candidate and `rebase-blocked` issues |

No newer clean tag is a successful no-op.
A confirmed block still allows an earlier clean target; a conflict past the horizon is not one.

## Auto-rebase modes

| Value       | Behaviour                                                |
| ----------- | -------------------------------------------------------- |
| `off`       | Mirror and report. No ref rewritten; issues still upsert |
| `candidate` | Publish the verified stack to `hyprws-next` only         |
| `on`        | Save `hyprws-previous`, rewrite `hyprws` under a lease   |

`HYPRWS_AUTO_REBASE` unset means `candidate`, and the mode governs the bot only.
In `on` mode a landing that triggers a rebase produces two nightlies by design.
`off` and `candidate` suppress the trunk push, so a walk there ends at its report.

### Which walk modes publish, per ref

| Walk                                 | `hyprws` | `refs/fork/churn` | `refs/fork/rerere` | Comments |
| ------------------------------------ | -------- | ----------------- | ------------------ | -------- |
| `unblock-auto`, `off` or `candidate` | no       | local row         | no                 | no       |
| `unblock-auto --bot-carried`         | yes      | yes               | yes                | yes      |
| `record-decisions`                   | no       | yes               | yes                | yes      |
| `unblock-apply`                      | yes      | yes               | yes                | yes      |

An unblock never moves `hyprws-previous`, `hyprws-next`, or a release ref.

### Carried unblock walk

In `on` mode the carry job restores rerere, then walks non-interactively.

```bash
node scripts/fork-sync.ts unblock-auto --bot-carried --target <newest tag beyond the block>
```

| Exit | Meaning                                   |
| ---- | ----------------------------------------- |
| 0    | Applies under its lease, posts the record |
| 2    | A legal stop, surfaced on the block issue |
| 3    | A precondition refused. Nothing written   |

Exit 2 has two reasons, written to `walk.stop` and the issue:

- **`environment`:** the lane cannot test
- **`conflict`:** reserved for a human

`conflict` covers an undecidable row, a failing repair, an unhealthy replay, and drift needing adaptation; anything else halting the walk is a bug.

`--bot-carried` requires `GITHUB_RUN_ID`, mode `on`, and the bot's last recorded run being this run.
Rerere is written back under expected-old leases; a differing resolution at one cache path refuses publication.
Failed publication exits nonzero; rerun with `--report <report>`.

## Bot-owned refs

Never create, move, delete, or force-push these by hand:

| Ref                                        | Meaning                       |
| ------------------------------------------ | ----------------------------- |
| `hyprws-previous`                          | Pre-rewrite trunk head        |
| `hyprws-next`                              | Verified candidate stack      |
| `release/vX.Y.Z-hyprws`                    | Create-only stable snapshot   |
| `archive/hyprws-pre-rewrite-<12-char old>` | Create-only pre-rewrite trunk |
| `refs/fork/churn`                          | Churn ledger orphan history   |
| `refs/fork/rerere`                         | Shared `.git/rr-cache`        |

`refs/fork/*` is append-only and never rebased, so walk data never enters the series.

```bash
git fetch origin '+refs/fork/*:refs/fork/*'
git show refs/fork/churn:fork-churn.json
```

### Churn ledger

Authoring scans read `refs/fork/churn` and print its ref, SHA, and freshness.

Record schemas, seam identity, seam states, and importer validation live in `scripts/lib/fork-churn-seams.ts`.

| Command                     | Use                                    |
| --------------------------- | -------------------------------------- |
| `fork:churn compose --plan` | Build a bundle from local artifacts    |
| `fork:churn record --input` | The only import path. Attested bundles |
| `fork:churn outcome`        | Record one receipt per selected target |

`--ledger-ref` reads another `refs/fork/<name>`, `--offline` queries nothing and says so, and `--push` leases the advertised ref.
Stale, offline, or blocking evidence records `report-policy: failed` while the run stays green.
Freeze a seam's census and mapping before rewriting its path, subject, or split.
Malformed input leaves the ref untouched; a failed push restores it.

Three seam states block: `returned-unresolved`, `repair-unverified`, `regressed`.
Neither absence nor a recorded guard clears one; only comparable verification does.
`unblock-apply` appends its own row, so `append --push` is only for a row no apply wrote.
Each report run replaces the `## Churn` section on the open block issue.

## Regenerable files

A sync keeps the new base's version and runs the registered generator after applying fork source inputs.
It never 3-way merges generated entries, nor treats a rerere result as one.

| Path             | Generator                    | Rebase rule                                                       |
| ---------------- | ---------------------------- | ----------------------------------------------------------------- |
| `pnpm-lock.yaml` | `vp install --lockfile-only` | Restore from `HEAD`, resolve sources, regenerate, stage, continue |

Re-run the generator when either side changed a manifest or the lockfile; add a row only with its deterministic generator.
`vp run fork:lockfile` proves the same on a feature branch; only `importers` drift fails.

## Reading a bot run

Read the latest run's **Auto-rebase** job summary, not just the conclusion:

```bash
gh run list --workflow hyprws-upstream-sync.yml --limit 1 -R RSI-Software/t3code-hyprws
gh run view <run-id> [--log-failed] -R RSI-Software/t3code-hyprws
```

Status is `off`, `no-op`, or `advanced`; a remaining block adds **Blocked beyond the clean window**.
Conflict tables and affected fork commits live in the `rebase-blocked` issue.
In candidate mode, compare its rebased head with `origin/hyprws-next`.

### Block issue lifecycle

| Rule       | Detail                                             |
| ---------- | -------------------------------------------------- |
| One open   | Identified by the exact `blocking-sha` body marker |
| Filed once | Per blocking SHA, including after a manual close   |
| Rotation   | The old issue closes by identity before a new one  |
| Refresh    | Body rewritten silently; title unchanged           |
| Horizon    | One **Refresh log** comment, edited in place       |
| Notices    | Assignment on creation, a comment on close         |

Refresh-log glyphs: `o` commit, `X` block, `N` nightly, `S` stable, `Nc` conflicting fork commits.
Dedupe assumes the marker and label stay intact.

## Unblocking a `rebase-blocked` issue

Run from a disposable worktree off the trunk, after `node scripts/setup-worktree.ts`:

```bash
git worktree add --detach <dir> origin/hyprws
vp run fork:sync unblock-auto [--target tag@sha] [--report <path>]
```

One invocation walks one eligible tag end to end: select, orient, resolve, repair, guard, apply, append the churn row, push.
That push starts the next run, which the walk does not await.
It takes no `--resume`: a report on disk is a walk in flight, picked up where it stopped, and it re-lists once if `origin/hyprws` moves under it.

### Walk pause

Set candidate mode before a walk, until the series ends:

```bash
gh variable set HYPRWS_AUTO_REBASE --body candidate --repo RSI-Software/t3code-hyprws
```

No second run is needed after an apply: the leased push triggers it.
Confirm the blocked issue closes with `Resolved by hyprws <sha>` and the next opens, or that none remains.
Restore `on` at the end of the series; deleting the variable restores it.

### Conflict doctrine

Conflict resolution is machine-owned: each path goes to shared rerere first, then the executor in this order.

| #   | Rule                                            |
| --- | ----------------------------------------------- |
| 1   | Only upstream moved, so upstream's text stands  |
| 2   | Only the fork moved, so the fork keeps working  |
| 3   | Both moved, keep both, if every hunk co-inserts |

There is no "upstream superseded this" rule: retirement stays a human decision in [fork-delta](../internals/fork-delta.md).

These refuse rather than stage, each a `conflict` stop:

- **Dropping a line upstream added:** never
- **A seam both sides rewrote:** says two things
- **No common ancestor:** add/add, rename, delete
- **Binary files:** no hunk model

### Additive proof

The walk proves the replayed tree purely additive over the target:

- **No target file deleted**
- **No migration deleted or renumbered**
- **No upstream test shrunk**
- **No upstream-deleted line re-added**

It repairs a failure once in one `Fork-Repair` commit: restore from the tag, renumber a colliding migration, drop re-added lines.
Any shape the fix refuses is the `conflict` stop.

### Lane repair

Repair runs in the same invocation, scoped to what the replay touched.

| #   | Step                                     |
| --- | ---------------------------------------- |
| 1   | Format resolved paths and repair commits |
| 2   | Typecheck each touched workspace         |
| 3   | Focused tests beside the touched sources |
| 4   | Every lane `*.fork.test.{ts,tsx}`        |

Formatted repairs commit before the additive gate; a later formatter rewrite reruns the battery once, and further drift is a stop.
Trunk CI runs the full battery after the apply.

- **Tools cannot run:** the `environment` stop
- **A repair fails on merit:** the `conflict` stop

Workflow drift needing adaptation stops the walk, as does an actionable `fork:scan` failure; a byte-identical fork side only needs a refreshed reviews row.
A repair becomes a `fixup!` to its owning commit; an ownerless path needs `--seam-owner '<path>=<owner sha>'`.
A conflicted autosquash aborts and restores the lane head.

### Decision records

Every walk keeps one durable record per decision, on the report's `## Decisions`.

```bash
vp run fork:sync record-decisions --report <json> --tag <tag>
```

Run it from the stopped session after resolving and staging the seam.
It flushes the resolution into shared rerere, posts the record, and writes the tag's ledger row as `pending`.
The next walk resolves the same content from that record; the applied row upgrades the pending one.

Retirement remains human; only a `retire` verdict drops a commit.

### The fold rule

A walk leases `origin/hyprws` at its `expected_old` but does not freeze landings, so a linear trunk advance folds.

| Situation             | Behaviour                                                 |
| --------------------- | --------------------------------------------------------- |
| `replayed`, `checked` | `unblock-fold` replays `B..live`, regresses to `replayed` |
| Stale leased push     | `unblock-apply` folds and retries, three attempts         |
| `conflicts` walk      | Defers the fold instead of voiding                        |
| Cannot fold           | Voids the rehearsal, costs the full replay                |

Movement that cannot fold: a merge commit, a rewritten trunk, a moved base or target.
A tooling fix the walk needs goes into its lane, never onto `hyprws` mid-walk.

### Verb ladder

`unblock-auto` runs these in one invocation; each stays callable for diagnostics, a stopped walk, and the series rewrite.

| #   | Verb               | Contract                                                   |
| --- | ------------------ | ---------------------------------------------------------- |
| 1   | `unblock-list`     | One current block, selectable tags; `--all` lists all      |
| 2   | `unblock-orient`   | Proves the tag was offered; pins base, `expected_old`      |
| 3   | `unblock-rehearse` | Creates or resumes the lane; a stop names its paths        |
| 4   | `unblock-check`    | Classifies lock drift, installs, scans locally             |
| 5   | `unblock-review`   | Series rewrite only. Signs or withholds a `checked` report |
| 6   | `unblock-apply`    | Gate, record, snapshots, leased apply, announce            |

The walk decides every row rather than asking; a human-filled cell beats a rerun.
`pnpm-lock.yaml` takes the [regeneration rule](#regenerable-files); a repaired seam needs `--silent-seam '<path>=<summary>:type'`.
Snapshots go before the apply; a failed announcement never voids it.

`unblock-check` restores the replayed lockfile for snapshot-only drift; any other drift needs exactly one owning commit, so a series rewrite always throws here.
Rerunning it on a `checked` lane rebinds the head and voids prior CI and review evidence.

Each verb consumes the previous report and atomically advances it; no shell variable carries gate state, and both files stay outside the repo.
Every transition refuses stale refs, wrong lanes, incomplete rows, unowned drift, failed checks, and a missing, stale, or withheld review.

### Series rewrite review

The **series rewrite** is a human-driven lane rewriting the whole stack at once.
Only it pushes a rehearsal lane, waits on CI up to 45 minutes, and needs a second session's review before apply.
A timeout or red run fails the gate; a reviewer elsewhere records one verdict:

```bash
vp run fork:sync unblock-review --report <report> --sign-off | --withhold '<reason>'
```

The verdict reads its identity from `ghb attest handoff` in the active runtime; never copy a handoff between sessions.

Withhold sign-off for:

- **Undefined fork intent**
- **A non-equivalent retire**
- **A user-visible behaviour change**
- **A domain or tier topology change**
- **Any bypass or unverifiable evidence**

Apply names this the **nightly review gate**: one recorded verdict on a `checked` report.
It runs `fork:upstream-refs` on the record first, so a refs-only fix keeps the verdict.
It refuses a withheld or missing review, a proposing-session verdict, changed bindings, and a moved lease.

## Historical rewrite construction

`vp run fork:sync rewrite-build --manifest <reviewed-json> [--json]` builds an exact same-base history from reviewed snapshot changes.
Manifest schema `fork.rewrite-manifest.v1`, its proofs, and its refusals live in `scripts/lib/`.

It publishes nothing: it writes unreferenced objects plus `<manifest>.receipt.json`, and every gate rebuilds rather than trust that receipt.
The final tree must equal the frozen source, tests included, preserving every header but `gpgsig`.
Manifests and proofs stay outside the checkout.

Pause the bot for the series, then:

```bash
vp run fork:sync rewrite-build --manifest /external/reviewed.json --json
vp run fork:sync rewrite-rehearse --from <receipt-sha> --manifest <same> --issue <live-block>
```

Finish on the normal `unblock-check`, `unblock-review`, `unblock-apply` ladder.

The lane binds its exact receipt, base tag, blocking marker, and base outcome declaration; a changed candidate or moved source voids it.
A same-base apply does not resolve the upstream blocker: start a fresh tagged walk.
`rewrite-rehearse` archives the old trunk at `archive/hyprws-pre-rewrite-<12-char expected-old>` first, and a rejected lease keeps that archive.
The rewrite never moves `hyprws-previous`.

## Cut a stable release

One `release`-labelled `Notification 🔔` issue per stable snapshot is the entry point; invoke the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill at **cut stable**.

| Verb             | Does                                                     | Refuses on                           |
| ---------------- | -------------------------------------------------------- | ------------------------------------ |
| `stable-list`    | Validates open candidates, writes a report               | An issue number; a human selects     |
| `stable-prepare` | Binds the snapshot, cuts `cut/vX.Y.Z-hyprws`, drafts UAT | Tag collision, dirty lane, red CI    |
| `stable-publish` | Tags the snapshot SHA, closes the candidate              | Inexact go, stale snapshot, no asset |

Candidate identity is the `<!-- hyprws-stable-candidate: <name> -->` marker; a title homing marker is accepted, never typed.
`stable-prepare` installs frozen, runs `fork:delta --check`, takes every verdict from `hyprws CI` on the pushed head, and carries prior UAT conditions.
A failed preparation removes the cut lane and needs a fresh `stable-list`.
`stable-publish` needs the human to repeat the candidate, and an `.AppImage` plus `latest-linux.yml` on the tag run.

### Release snapshots

A release snapshot is the immutable branch a stable tag is cut from, never following later work.

**A stable upstream tag is snapshotted and announced by whichever lane moves the fork base past it.**
An unblock apply therefore snapshots every crossed stable tag before pushing, checking replay shape only.

`hyprws-release.yml` fires on every push to `hyprws`, so a leased apply cuts the nightly by itself.
Only stable needs a candidate, a UAT cycle, and an explicit human go.

### UAT boundary

The preparation stop is the [`fork-uat`](../../../.agents/skills/fork-uat/SKILL.md) judgement boundary.

| #   | Step                                                           |
| --- | -------------------------------------------------------------- |
| 1   | Agent reviews sources and carried conditions                   |
| 2   | `fork:uat --prepare` builds a parent and a child per condition |
| 3   | Agent shows the bundle; a human go permits `--create`          |
| 4   | Human runs the candidate and closes passing children           |

A `Signed off` parent comment is recommended, but no closure gates automatically.
Omitting `--since` selects the newest eligible stable tag; passing it marks the snapshot `(overridden)`.

### Stable sign-off stop

Present the selected issue, snapshot branch and SHA, derived tag, prior tags, preparation results, and UAT evidence.

The human withholds the go if the app cannot launch or basic use fails; open children, polish findings, and a missing sign-off stay non-blocking.
After a refusal, return to `stable-list`.

The issue close, immutable tag, workflow run, and GitHub release are the record.
An `upstream-watch` issue closes only once the released build is installed and verified.

## Recovering local lanes after a rewrite

Feature lanes start from `hyprws`, never `hyprws-next` or a `release/*` snapshot.

```bash
git fetch origin hyprws hyprws-previous
git rebase --onto origin/hyprws origin/hyprws-previous <feature-branch>
```

`hyprws-previous` does not exist until the first on-mode run; take that boundary from the **Auto-rebase** summary's old head.
Inspect the range first if the lane was not based on it; never guess an `--onto`.

Reset the canonical `hyprws` worktree with `git reset --hard origin/hyprws`, never a feature worktree.

## One-time repository setup

### Bot token

Create a fine-grained token owned by the automation actor, scoped to this repository, with read-and-write **Contents** and **Workflows**.
Store it as the `HYPRWS_MIRROR_TOKEN` Actions secret.
The workflow uses its own `GITHUB_TOKEN` with `issues: write`; never widen the token.

### Labels

The workflow force-creates `rebase-blocked` every run, overwriting a drifted one:

```bash
gh label create rebase-blocked --force --color B60205 \
  --description "The fork stack conflicts with newer upstream history" \
  -R RSI-Software/t3code-hyprws
```

The `release` label must exist before the first stable snapshot; nothing creates it.

### Which events run the fork matrix

`hyprws-ci.yml` produces every context the `hyprws` ruleset requires: `Check`, `Test`, `Test Scripts`, and three `Test Server` shards.
It runs on a pull request opened, pushed to, or reopened, on a push to a fork trunk, rehearsal, or release branch, and on `merge_group`.

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

Fork CI checks a body for squash-commit ledger trailers only on a ready pull request based on `hyprws`.
Drafts and every other base skip it, rehearsals included, which land by leased force-push.

### Runners

Both fork workflows run on `ubuntu-latest`.
`hyprws-release.yml` publishes a nightly on every landing, with a six-hour fallback schedule.
It keeps the newest 7 nightlies and deletes older ones with their tags; stable is never pruned.

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

| Failure                        | Response                                              |
| ------------------------------ | ----------------------------------------------------- |
| **Mirror fails**               | Recreate the token. Someone wrote `main`; never force |
| **No clean target**            | Report-only. Never target an untagged commit          |
| **Feasible, replay conflicts** | An automation bug. Never resolve in the bot worktree  |
| **Replay verification fails**  | Fix by pull request; never weaken the comparison      |
| **Trunk lease rejected**       | Inspect and rerun; never swap in `--force`            |
| **A rehearsal branch exists**  | Already rehearsed against that target. Inspect it     |
| **A stable snapshot exists**   | Immutable. A correction needs a new record            |
| **A blocked issue remains**    | Unblock entry point. Retirement needs a decision      |
| **Stable release fails**       | Fix and rerun. Never move a published tag             |

## Version ordering caveat

Semver precedence is global even though the updater separates channels: `0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2` and promotes nothing.
Never infer channel or recency from a mixed sort; filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
