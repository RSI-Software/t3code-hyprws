# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

The `hyprws upstream sync` workflow is the normal upstream-sync operator. It mirrors upstream, finds
the newest upstream release tag the fork can reach without a textual conflict, verifies a replay of
the complete fork stack, and publishes the result according to the configured mode. A maintainer
intervenes only to resolve a reported block, enable trunk rewrites, or cut a stable release.

[Fork development](../internals/fork-development.md) owns the repository discipline. The repo-local
[`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill owns the gated nightly review and stable human sign-off procedures
for unblocking a rebase and cutting a stable release.

## Model

`hyprws` is the single fork trunk. The bot scans only through the newest stable or nightly upstream
tag on the first-parent lane, never through an untagged `upstream/main` head. Its upstream base is the
newest clean tag within that horizon; when stable and nightly tags point at the same position, stable
wins the tie. The bot never merges upstream into the fork and never drops, squashes, reorders, or
rewords a fork commit.

On each scheduled, pushed, or manually dispatched run, the workflow:

1. fast-forwards the fork's `main` mirror to `upstream/main`;
2. scans through the newest upstream release tag and finds the newest clean tag within that horizon;
3. snapshots every stable upstream tag its own walk crosses on a create-only release branch;
4. replays and verifies the whole fork stack on the selected tag;
5. publishes the candidate or rewrites `hyprws`, according to `HYPRWS_AUTO_REBASE`; and
6. creates or updates stable-candidate and `rebase-blocked` issues as `Notification 🔔` signals.

A run that has no newer clean release tag is a successful no-op. The sequential rebase census to the
newest tagged horizon decides the outcome when available: zero conflicting fork commits advances to
that tag, while one or more confirms a block at the pairwise scan's first conflicting upstream
commit. If the census fails or reaches a limit, the pairwise result decides and the block records why
the census was unavailable. A confirmed block does not prevent the bot from advancing to an earlier
clean target. A conflict in untagged commits past the horizon is not a block.

## Regenerable files

The regeneration shape covers lockfiles, generated indexes, and version stamps. These files carry
no independently reviewable fork intent: a sync keeps the incoming new-base version and runs the
registered generator after applying the fork's source inputs. It never 3-way merges generated
entries or treats a rerere result as a resolution.

The only path currently registered in this class is:

| Path             | Generator                    | Rebase rule                                                                                                                           |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml` | `vp install --lockfile-only` | At a stop, restore from `HEAD`, resolve the remaining source conflicts, run the generator, stage the result, and continue the rebase. |

`vp install --lockfile-only` is the repository-native equivalent of
`pnpm install --lockfile-only`. During a rebase, `HEAD` is the selected upstream base plus fork
commits already replayed, so restoring from it discards the old fork lockfile while retaining the
new-base side. Re-run the generator on the completed replay when either side changed package
manifests or the lockfile; it must be stable before apply. No generated index or version stamp is
currently registered—add one only with its deterministic generator and an update to this table.

## Bot-owned refs

Do not create, move, delete, or force-push these refs by hand:

| Ref                     | Meaning                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `hyprws-previous`       | The pre-rewrite `hyprws` head saved by the bot before an automatic trunk rewrite.   |
| `hyprws-next`           | The verified candidate stack published while the repository is in candidate mode.   |
| `release/vX.Y.Z-hyprws` | A create-only snapshot of the fork stack on upstream stable `vX.Y.Z`.               |
| `refs/fork/churn`       | The churn ledger: one orphan history holding `fork-churn.json`, one entry per walk. |
| `refs/fork/rerere`      | The shared `.git/rr-cache`, so a carried walk replays what earlier walks resolved.  |

The `refs/fork/*` family is append-only and is never rebased, so a walk's data never enters the
fork series and no rebase has to carry it. Read one without a checkout:

```bash
git fetch origin '+refs/fork/*:refs/fork/*'
git show refs/fork/churn:fork-churn.json
```

### Churn ledger

The ledger moved off `docs/internals/fork-churn.json` onto `refs/fork/churn`. The document at
`docs/internals/fork-churn.md` is a frozen mirror; RSI-Software/t3code-hyprws#476 retires both
files, along with the `docs(fork-churn): row ...` commits, at a later rebase. Seed the ref once
from the file, from a clean canonical checkout of `hyprws`:

```bash
node scripts/fork-churn.ts seed --from docs/internals/fork-churn.json --push
```

Verify with `git show refs/fork/churn:fork-churn.json | head`. Until the ref exists, every reader
refuses rather than reporting an empty ledger.

Ledgers seeded before census subjects became durable need one migration from a trusted checkout
whose local object store still resolves every census SHA. Do not rely on a fresh fetch: pruned
fork-nightly refs cannot restore their commits. Run exactly once while those objects are available:

```bash
node scripts/fork-churn.ts migrate-subjects --push
```

The all-or-nothing census-subject guard resolves every missing subject before moving the local ref,
names every unresolved SHA together, and pushes with an exact expected-old lease. A rerun after
success is a no-op. A failed leased push restores the local ref to its exact pre-migration commit,
so after fetching the remote winner the migration can be retried; never replace a rejected lease
with an unleased force push. `report` stays read-only with respect to the ledger and refuses a
subjectless ledger instead of consulting historical Git objects.

After each walk, `node scripts/fork-churn.ts append ... --push` adds the row and publishes the ref.
Each report run posts a `## Churn` section on the open block issue with the conflict class mix, the
agent/human split, the silent seams, and the hot-seam movement since the previous report. The
section replaces itself, so the issue carries one live view.

A release snapshot never follows later trunk work. It is the immutable branch from which a human
chooses a stable fork tag.

**A stable upstream tag is snapshotted and announced by whichever lane moves the fork base past it.**
The bot only sees the tags inside its own walk window, so a tag the base has already passed is
invisible to it forever after. An unblock apply therefore snapshots every stable tag it crosses
before it pushes the trunk, replaying the pre-apply stack onto each one exactly as the bot would.
Each snapshot is checked for replay shape only, because `stable-prepare` runs the full verification
again before it mints a tag. A tag whose snapshot cannot be replayed mechanically is named in a
warning and skipped; the apply that crossed it is already rehearsed, checked, and proved, so it
stands. Snapshot that tag by hand before cutting it.

The two channels are cut differently. `hyprws-release.yml` fires on every push to `hyprws`, so a
leased apply cuts the nightly by itself and no operator ever cuts one. The stable channel is the
only one that needs a `stable-list` candidate, a UAT cycle, and an explicit human go.

## Auto-rebase modes

The repository variable `HYPRWS_AUTO_REBASE` accepts three values. An unset variable means
`candidate`.

| Value       | Behaviour                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `off`       | Mirror and report only. No candidate or trunk ref is rewritten; blocked issues are still upserted or closed.        |
| `candidate` | Publish the verified stack to `hyprws-next`; still create stable snapshots and issues, but do not rewrite `hyprws`. |
| `on`        | Save the old trunk as `hyprws-previous`, then rewrite `hyprws` with an explicit expected-old lease.                 |

In `on` mode, a landing that triggers a rebase produces two nightlies by design: one for the landed
commit and one for the bot-pushed rebased head.

The mode governs the bot only. An unblock apply snapshots and announces the stable tags it crosses
in every mode, because those tags leave the bot's window the moment the apply lands.

### Carried unblock walk

In `on` mode a blocked candidate does not stop at the report. The workflow's carry job restores the
shared rerere cache from `refs/fork/rerere` and then runs the walk non-interactively:

```bash
node scripts/fork-sync.ts unblock-auto --bot-carried --target <newest tag beyond the block>
```

The walk's own exit code decides the run:

| Exit | Meaning                            | The run                                                               |
| ---- | ---------------------------------- | --------------------------------------------------------------------- |
| 0    | Every conflict was mechanical      | Applies under the walk's own expected-old lease and posts the record. |
| 2    | A gate stopped on a real judgement | Posts the stop surface verbatim on the block issue for an agent.      |
| 3    | A precondition refused the walk    | Reports only. Nothing is written.                                     |

`--bot-carried` refuses unless `GITHUB_RUN_ID` is set, `HYPRWS_AUTO_REBASE` is `on`, and the bot's
last recorded run is this run, so a carried walk can never take a lease another run holds. The
workflow's `hyprws-rebase` concurrency group is the outer guard. `off` and `candidate` never carry.
The carry job passes `HYPRWS_AUTO_REBASE` in as an environment value because a job token may not
read repository variables, and an injected mode always wins; the API read is the human lane's
fallback.

A `--target` pins the walk to a tag that cannot move, so every step reports mirror currency without
requiring it: the same run pushed the mirror minutes earlier, and upstream can advance again before
the carry reads it.

A carried walk mints its rehearsal lane with `git worktree` rather than Worktrunk, which a runner
cannot install, and skips the post-apply reconciliation dispatch because its own leased push to
`hyprws` already starts the next run. The rerere cache is written back to `refs/fork/rerere` after
every carried walk, applied or stopped, and after every leased apply.

### Walk pause

Before an unblock walk, set the bot to candidate mode and leave it there until the ladder or walk
series ends:

```bash
gh variable set HYPRWS_AUTO_REBASE --body candidate --repo RSI-Software/t3code-hyprws
```

After each apply, dispatch one reconciliation run from the new `hyprws` head:

```bash
gh workflow run hyprws-upstream-sync.yml --repo RSI-Software/t3code-hyprws
```

Confirm the blocked issue closes with `Resolved by hyprws <sha>` and the next block opens, or no block
remains. Restore `on` only when the ladder or walk series is complete.

### Block issue lifecycle

The bot keeps at most one open `rebase-blocked` issue and identifies it by the exact
`blocking-sha` marker in its body. A blocking SHA is filed at most once, including after its issue is
manually closed. When the first conflict changes, the bot closes the old issue by identity before it
creates a new one.

#### Assumptions

The workflow concurrency group is the single writer for block issues. Dedupe also assumes that the
`blocking-sha` marker and `rebase-blocked` label remain intact on every open or closed block issue.
Stripping either can let the same SHA be filed again.

While a block remains, each run silently rewrites the issue body without changing its title. One
**Refresh log** comment records the tagged horizon in an ASCII lane: `o` is a commit, `X` is the
block, `N` is a nightly tag, `S` is a stable tag, and `Nc` is the number of conflicting fork commits
to that tag. The bot edits that comment in place and appends a row only when the newest tag past the
block changes.

The issue is assigned to `donjor` when created and receives a one-line comment when closed. Those are
the only human notifications for a block; routine body and Refresh log edits are silent. Reporting
and this lifecycle run in every `HYPRWS_AUTO_REBASE` mode.

The repository intentionally starts in candidate mode. After reading a successful candidate run and
preparing local lanes for recovery, enable automatic trunk rewrites with:

```bash
gh variable set HYPRWS_AUTO_REBASE --body on -R RSI-Software/t3code-hyprws
```

To return to report-only or candidate operation, set the same variable to `off` or `candidate`.
Deleting it also restores the candidate default.

## One-time repository setup

### Bot token

Create a fine-grained personal access token owned by the automation actor, limited to
`RSI-Software/t3code-hyprws`, with these repository permissions:

- **Contents: Read and write** — mirror, candidate, snapshot, and leased trunk pushes;
- **Workflows: Read and write** — mirrored upstream commits can change workflow files.

Store it as the `HYPRWS_MIRROR_TOKEN` Actions secret. The command prompts for the token value:

```bash
gh secret set HYPRWS_MIRROR_TOKEN -R RSI-Software/t3code-hyprws
```

The workflow uses its normal `GITHUB_TOKEN` with `issues: write` for labels and issues. Do not widen
the personal access token for issue management.

### Labels

The workflow force-creates `rebase-blocked` on every run. Its `--force` flag overwrites a drifted
description with the workflow-owned text:

```bash
gh label create rebase-blocked --force --color B60205 \
  --description "The fork stack conflicts with newer upstream history" \
  -R RSI-Software/t3code-hyprws
```

The `release` label must already exist before the first stable snapshot, because the workflow does
not create it. This repository already has it; verify that it remains available:

```bash
gh label view release -R RSI-Software/t3code-hyprws
```

### Which events run the fork matrix

`hyprws-ci.yml` produces every context the `hyprws` branch ruleset requires: `Check`, `Test`, and
the three `Test Server` shards. It runs on a pull request that is opened, pushed to, or reopened, on
a push to a fork trunk, rehearsal, or release branch, and on `merge_group`.

It deliberately does not run on `ready_for_review`. GitHub already runs `pull_request` on a draft,
so the matrix has normally passed on that exact head before the draft is marked ready; listing the
event only discards a green result and pays for it again.

The `merge_group` trigger is what makes a merge queue possible. A queue builds
`gh-readonly-queue/hyprws/**` and waits for the required contexts on that ref. Because this workflow
owns all of them, a queue without that trigger receives no report at all and each entry sits until
it times out. Add the trigger before requiring a queue in the ruleset, never after.

### Upstream workflows and merge settings

Keep only `hyprws-ci.yml`, `hyprws-release.yml`, and `hyprws-upstream-sync.yml` enabled. Upstream
workflows remain in the tree unchanged but disabled, because they expect upstream secrets and
runners.

```bash
gh workflow list --all --repo RSI-Software/t3code-hyprws
for workflow in ci.yml release.yml pr-size.yml pr-vouch.yml web-preview.yml deploy-relay.yml \
  publish-aur.yml issue-labels.yml thread-transfer-report.yml mobile-eas-preview.yml \
  mobile-eas-production.yml mobile-fingerprint-check.yml mobile-showcase-screenshots.yml; do
  gh workflow disable "$workflow" --repo RSI-Software/t3code-hyprws
done

gh repo edit RSI-Software/t3code-hyprws \
  --enable-squash-merge --enable-rebase-merge=false --enable-merge-commit=false \
  --delete-branch-on-merge
gh api -X PATCH repos/RSI-Software/t3code-hyprws \
  -f squash_merge_commit_title=COMMIT_OR_PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES
```

### Applied rulesets

The rulesets tracked in RSI-Software/t3code-hyprws#220 are applied manually in
**Settings → Rules → Rulesets** and are all `active`. This repository does not apply or change them
unattended:

- **`hyprws`:** targets `refs/heads/hyprws`; requires a pull request with 0 approvals and the status
  checks `Check`, `Test`, `Test Server 1`, `Test Server 2`, and `Test Server 3`; repository
  administrators have an always-allow bypass. The bot pushes with the administrator's PAT and must
  force-push after a rebase, so this ruleset deliberately has no force-push rule.
- **`main`:** targets `refs/heads/main`; requires a pull request and has the same always-allow
  repository-administrator bypass. Only the mirror job writes this branch.
- **`no trunk deletion`:** targets `refs/heads/hyprws` and `refs/heads/main`; blocks deletion and has
  no bypass actors, so it binds administrators and the bot too.
- **`stable tags`:** targets `refs/tags/v*-hyprws.*` and excludes `refs/tags/v*-hyprws-nightly.*`;
  blocks deletion and updates and has no bypass actors.

A direct non-bypass push to `hyprws` cannot be demonstrated because the repository has no non-admin
collaborator, so the pull-request rule is documented as admin-only until one exists.

The fork CI checks the pull-request body for squash-commit ledger trailers only on a ready pull
request whose base branch is `hyprws`. It skips drafts and every non-`hyprws` base, including
rebase-rehearsal branches, because those rehearsals land by a leased force-push rather than a squash
merge.

### Runners

Both fork workflows run on `ubuntu-latest`.
`hyprws-release.yml` publishes a nightly on every landing on `hyprws`; its six-hour schedule is a
fallback that publishes only when the head differs from the newest nightly tag. The release job
keeps the newest 7 nightlies and deletes older releases with their tags; stable releases are never
pruned.
GitHub-hosted runners are free for a public repository, and pull requests from outside the org cost nothing.

The rsi-ci pool was measured on 2026-08-23 and rejected.
Five concurrent jobs on one 12-core container reached wall times at parity with hosted at best.

Revisit only if the pool grows or the repository goes private.
The runbook `docs/runbooks/ci-runners.md` in `RSI-Software/ops` owns the pool.

Tools the workflows need beyond the hosted image:

| Tool             | How the workflow gets it                                          |
| ---------------- | ----------------------------------------------------------------- |
| Node and `vp`    | `voidzero-dev/setup-vp@v1` installs into the workspace cache.     |
| Rust and `cargo` | `dtolnay/rust-toolchain@stable` installs under the runner's home. |
| ImageMagick      | Present on the hosted image; `apt-get` when it is missing.        |

Treat a missing tool as a workflow task, not a reason to patch the build script.

### Optional T3 Connect config

The fork build leaves T3 Connect unconfigured unless these repository variables exist:

- `T3CODE_RELAY_URL`
- `T3CODE_CLERK_PUBLISHABLE_KEY`
- `T3CODE_CLERK_JWT_TEMPLATE`
- `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`

The workflow passes them through when set and leaves the feature dark when they are not.

## Reading a bot run

Open the latest `hyprws upstream sync` run and read the **Auto-rebase** job summary, not only the
green or red conclusion:

```bash
repo=RSI-Software/t3code-hyprws
gh run list --workflow hyprws-upstream-sync.yml --limit 5 -R "$repo"
run_id="$(gh run list --workflow hyprws-upstream-sync.yml --limit 1 \
  -R "$repo" --json databaseId --jq '.[0].databaseId')"
test -n "$run_id"
gh run view "$run_id" -R "$repo"
gh run view "$run_id" -R "$repo" --json url --jq .url
```

The summary emits exactly these top-level fields: mode, status, old head, base, target, rebased head,
and stable-candidate count. Status is `off`, `no-op`, or `advanced`. When a block remains, a
**Blocked beyond the clean window** block adds the first conflicting upstream commit, remaining
upstream commit count, and newest later tag.

The replay still verifies commit count and messages, the fork ledger, `vp check`, and typecheck
before any push, but the summary does not itemise those checks. The conflict table and affected fork
commits live in the `rebase-blocked` issue body, not in the run summary. If the run fails, inspect its
failed step separately:

```bash
gh run view "$run_id" --log-failed -R "$repo"
```

In candidate mode, compare the summary's **Rebased head** with the published ref:

```bash
git fetch origin hyprws-next
git rev-parse origin/hyprws-next
```

A green run with a `rebase-blocked` issue means the bot advanced as far as it safely could and then
reported the next operator task. It does not mean the entire upstream lane was clean.

## Unblocking a `rebase-blocked` issue

Start with `vp run fork:sync unblock-auto [--target tag@sha] [--report <path>]`. Alone, it selects the
open walk target (or the newest offered tag), accepts a coherent orientation, stages rerere and
generated resolutions, takes the pushed-lane CI verdict, and records the walking agent's clear keep
decisions. For a nightly target it then stops exactly once at the independent-review boundary; after
a distinct Claude Opus session signs the bound evidence, resume applies with the existing lease,
dispatches one reconciliation run, identifies its URL, and does not wait for completion.

The walking host hands the emitted report and record paths to Claude Opus. The reviewer inspects the
generated target, live blocking marker, every non-mechanical verdict, rehearsal evidence, pushed-lane
CI on the exact installed head, every silent seam, and the live `expected_old` lease. It then records
one of:

```bash
vp run fork:sync unblock-review --report <report> --sign-off
vp run fork:sync unblock-review --report <report> --withhold '<reason>'
```

The command records interface, provider, model, and session for both proposer and reviewer, reading
each identity from `ghb attest handoff` in the active runtime. Operators must not copy a handoff
between sessions or edit those fields into the report. The reviewer is an agent, not a human, and
its provenance is not replaced by the walking agent's identity. Sign-off is
withheld for undefined fork intent, a non-equivalent retire, a user-visible behaviour change, a fork
domain or tier topology change, any bypass, or evidence that cannot be verified. The existing
automation also pauses before review when it can detect those judgement surfaces. After sign-off the
walking host runs `vp run fork:sync unblock-auto --resume --report <report>`.

Apply names this control the **nightly independent-review guard**. It refuses a missing or withheld
review, a reviewer that is not Opus, the proposing session reviewing itself, any change to the
reviewed record/bindings, moved rehearsal or CI heads, and a moved lease. A new proposal or movement
requires a new independent review; never copy review fields between reports.

An objective bot-carried walk is exempt from the independent-review guard because it has no
agent judgement verdict. Any conflict or judgement stops the workflow before apply. Restart
that target in a host agent session; the host proposal and independent Opus review then become
mandatory. This preserves unattended clean nightlies without treating a workflow process as a
reviewer.

The report is an operator-owned state file, not a cryptographic signature. The command proves the
active runtime identity when it records review and binds that result to the record, refs, CI head,
and lease. An operator able to rewrite the external report can fabricate its contents; the control
is procedural provenance and stale-state detection, not protection from a malicious local operator.

Outside this objective nightly lane, orientation incoherence, a source conflict without a verified
resolution, retirement or behaviour judgement, undefined intent, domain/tier/topology change,
bypass, or unverifiable evidence remains a pause. Every judgement stop reproduces the interactive
surface and prints `node scripts/fork-sync.ts unblock-auto --resume --report <path>`; resolve that
surface without weakening a gate, then resume the same external report.

### Walk mode

Use the existing step-by-step verbs for the interactive path. `vp run fork:sync` owns the mechanics
as six report transitions. At each judgement stop, the human sees
the emitted decision surface verbatim, then one triage line per decision: `clear — <recommendation>:
<one-line reason>` for an unambiguous choice, or `judgement — <recommendation>: <reading A> vs
<reading B>; <why the recommendation>` when a real choice remains. The agent then asks for the exact
word for every decision and stops; its recommendation is never recorded as the human's answer.

1. `unblock-list` fetches and preflights, requires one current block, and writes an external report
   containing the full blocking SHA and selectable release tags. It accepts no target.
2. After the maintainer selects a tag, `unblock-orient` consumes that report, proves the target was
   offered and is beyond the block, and pins the target, shared base, and one `expected_old`.
3. `unblock-rehearse` creates the bound Worktrunk lane or resumes its rebase. Every rehearsal Git
   call carries `core.commentChar=auto`; rebase calls also enable rerere with index autoupdate
   disabled. At a stop it names the in-flight commit by subject and short hash, lists every
   conflicted path, and marks each reused rerere resolution in both the stop and its conflict row so
   the human reviews and stages it rather than authors it. For `pnpm-lock.yaml` it discards the
   textual/rerere result and applies the [regeneration rule](#regenerable-files) itself.
4. `unblock-check` classifies post-replay lock drift, installs at the replay head, and runs the fork
   scan and ledger locally. The scan is pinned to the tag the stack sits on: the walk target, or the
   release tag at the fork base for a trunk rewrite. A moved `upstream/main` therefore cannot fail a
   lane for upstream drift the lane did not introduce. Record one repaired seam with
   `--silent-seam '<path>=<summary>:type'` or
   `--silent-seam '<path>=<summary>:behaviour'`; the report preserves that evidence for Gate 4. It
   pushes the disposable rehearsal lane, then waits up to 45 minutes for the CI verdict on the
   pushed lane head, polling every 30 seconds. A timeout or failed job stops the gate with its failed
   log evidence. It then renders the decision and grounding surface.
5. For a nightly target, a walk-mode host first runs
   `vp run fork:sync unblock-auto --resume --report <report>` to bind its proposal identity and emit
   the review stop. `unblock-review` then binds the proposal record, target, blocking SHA,
   `expected_old`, installed/CI head, and rehearsal branch to a distinct Claude Opus session. A
   withheld review is durable and cannot apply. A non-nightly judgement path retains its recorded
   human decision boundary.
6. After the required sign-off, `unblock-apply` calls `fork:sync-gate`, refuses a lane moved since
   the CI verdict, posts the external record, snapshots every stable upstream tag the apply crosses,
   performs the expected-old leased apply, announces the snapshots as candidate issues, and deletes
   the remote rehearsal branch. Snapshots go up before the trunk, in the bot's own order, because a
   create-only branch stands on its own. A failed announcement prints the snapshot branches and never
   voids the apply; open those candidate issues by hand, because the bot will not see those tags
   again.

Each verb consumes the JSON report emitted by the previous verb and atomically advances it; no shell
variable carries gate state. The script also renders and validates the Markdown record schema. Its
focused tests are the schema definition, so there is no separate prose template to drift from it.
The report and record stay outside the repository and new rehearsals never add to
`docs/operations/fork-sync-records/`.

For an objective nightly walk, the host owns target selection and the proposal while one independent
Claude Opus session owns review and sign-off. A reviewer sign-off is never counted as a human
choice. Real semantic ambiguity, retirement/product judgement, grounding, user-visible change,
domain/tier/topology change, bypass, or unverifiable evidence still pauses for human direction. Every
other transition refuses stale refs, wrong lanes, incomplete rows, changed messages/counts, unowned
importer drift, failed checks, or missing/stale/self-approved/withheld review. A stale lease voids the
report; restart at `unblock-list` instead of refreshing it.
Never move `hyprws-previous`, `hyprws-next`, or a release ref as part of the unblock. A successful
leased push starts the bot run that reconciles the resolved blocking SHA and any later block. After
apply, append the walk to `refs/fork/churn` with `--push`; the next sync report renders it.

## Cut a stable release

Every stable snapshot gets one `release`-labelled `Notification 🔔` issue, whichever lane created it.
That issue is the whole entry point: a fresh session needs it and nothing else.

Exactly one candidate issue is open at a time. Each reconcile closes a candidate whose
`vX.Y.Z-hyprws.N` release tag is already on `origin` as completed, and closes a candidate an
open newer one has overtaken as not planned, commenting with the newer issue. Only the newest un-cut
candidate survives, so the issue `stable-list` offers is the live one.

Invoke the [`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill at its **cut stable** entry
point. The stable lane is three external-report transitions; no shell variable or pasted
multi-command block carries gate state:

1. `vp run fork:sync stable-list` runs fork preflight, reads every open stable candidate, validates
   each candidate title/body/marker, and writes an external selection report. It accepts no issue
   number. The human selects one of the reported issues; recency is not permission to infer it.
   The `<!-- hyprws-stable-candidate: <name> -->` body marker is the candidate's identity; a
   trailing `ghb`-owned homing marker on the title (`[📥]`, `[📍]`, or `[<emoji>#N]`) is accepted
   and never stripped or hand-written.
2. `vp run fork:sync stable-prepare --report <report> --issue <selected-issue>` rereads the exact
   selected issue, fetches its bot-owned snapshot and tags, binds the remote commit, and creates the
   collision-refusing `cut/vX.Y.Z-hyprws` Worktrunk lane. It installs with the lockfile frozen, then
   runs `fork:delta --check` through that lane's Vite+ binary and project environment. The `check`,
   typecheck, and test verdict comes from `hyprws CI`: the snapshot head is already pushed as
   `release/vX.Y.Z-hyprws`, so the prepare reverifies that remote head and waits up to 45 minutes for
   the run on that exact SHA, recording `hyprws CI <run-url>` in its verification list. A failed job
   or a timeout fails the prepare with the run URL and the failed-log tail before any UAT draft is
   rendered. The full battery never runs on the operator machine.
   It derives the next stable tag through the release helper,
   refuses a local or remote tag collision, and revalidates
   the snapshot, clean lane, and checked head. It also calls the existing `fork:uat` dry-run surface
   for the exact snapshot and writes the review draft beside the external report. The draft carries
   every applicable condition from the previous stable's UAT, preserving whether it was accepted or
   unsettled, alongside the new source material. Tooling comes from trunk
   and product comes from the snapshot, so the canonical checkout renders that draft against the
   snapshot ref while every content check above still runs through the lane. A preparation failure
   synchronously removes the cut lane, including lockfile drift, before requiring a fresh
   `stable-list`; if Worktrunk cannot remove it, the refusal prints the exact forced recovery
   command.
3. `vp run fork:sync stable-publish --report <report> --go <exact-candidate>` requires the human to
   repeat the selected `vX.Y.Z-hyprws` candidate after UAT judgement. It rereads the open candidate,
   refetches and revalidates the bound snapshot, clean lane, and absent tag, creates the annotated
   tag at the exact snapshot SHA, and pushes only that new tag. It asks Worktrunk to trash the cut
   lane, finds and watches the exact `hyprws-release.yml` tag run, requires an `.AppImage` and
   `latest-linux.yml`, then closes the candidate with the tag, snapshot SHA, and workflow URL.

The preparation stop is the [`fork-uat`](../../.agents/skills/fork-uat/SKILL.md) judgement boundary.
The agent reviews the rendered sources and carried conditions, writes observable task drafts, and
removes the reviewer-only sections. `fork:uat --prepare` compiles that review into a hashed parent
tracker plus one child issue per acceptance condition and preflights every filing. The agent shows
the exact bundle to the human; only an explicit human go permits `fork:uat --create`. The human runs
the candidate, closes each passing child, and leaves follow-up or polish work open with its findings.
A `Signed off` parent comment is recommended when the candidate is accepted in principle, but neither
that comment nor complete child closure is an automatic publication gate.

At the stable sign-off stop, present the selected issue, snapshot branch and SHA, derived tag, prior
matching tags, all preparation results, the clean/ref checks, and the UAT evidence. If the app cannot
launch or basic use fails, the human withholds the explicit release go. Ordinary open children,
polish findings, and missing parent sign-off remain non-blocking evidence. An inexact candidate/go,
stale snapshot, dirty or moved cut lane, issue change, tag collision, failed push, failed workflow,
or missing asset refuses advancement. Never increment again after a refusal without returning to
`stable-list` and obtaining a fresh human go.

The issue close, immutable tag, workflow run, and GitHub release are the stable-cut record. Do not
add a human sync record for an ordinary bot snapshot. An `upstream-watch` issue closes only after the
released build carrying its fix has been installed or run and the behaviour verified.

## Recovering local lanes after a rewrite

Feature lanes must start from `hyprws`, never from `hyprws-next` or a bot-owned `release/*` snapshot.
`hyprws-next` is an inspection ref: after the mode flips from candidate to on, it remains at the last
candidate push and goes stale. Release snapshots are immutable release inputs, not development bases.

`hyprws-previous` does not exist until the first on-mode run. For that first rewrite, copy the full
old head from the **Auto-rebase** run summary and use it as the old boundary:

```bash
git fetch origin hyprws
git rebase --onto origin/hyprws <old-head> <feature-branch>
```

After an on-mode run has published `hyprws-previous`, a feature branch based on the immediately
previous trunk can use the bot-owned ref directly:

```bash
git fetch origin hyprws hyprws-previous
git rebase --onto origin/hyprws origin/hyprws-previous <feature-branch>
```

Replace `<old-head>` with the summary's full old-head SHA and `<feature-branch>` with the branch
printed by `git branch --show-current` in that feature worktree. Inspect the range first if the lane
was not based on that old boundary; do not guess an `--onto` boundary. A lane mistakenly based on
`hyprws-next` or `release/*` needs its actual merge base inspected and cannot use the generic recovery
command safely.

The canonical `hyprws` worktree carries no independent commits. Reset it to the published trunk:

```bash
git fetch origin hyprws
git reset --hard origin/hyprws
```

Never run the hard reset in a feature worktree or a checkout with uncommitted work.

## Failure handling

- **Mirror fails:** recreate `HYPRWS_MIRROR_TOKEN` when the secret is missing or expired. A rejected
  fast-forward means someone wrote to `main`; inspect it and never force the mirror.
- **No clean target:** the run is report-only until an upstream release tag enters the clean window.
  Do not target an untagged commit.
- **Feasibility said clean but replay conflicts:** treat it as an automation bug. The bot aborts the
  rebase and pushes nothing; do not resolve inside the workflow worktree.
- **Replay verification fails:** the bot pushes nothing. Read the failed check and fix the fork or
  automation through a pull request; never weaken the commit-message or ledger comparison.
- **The `hyprws` lease is rejected:** remote work appeared after the bot read the old head. Inspect
  the new commits and rerun from them; never replace the explicit lease with `--force` or silently
  refresh it.
- **A rehearsal branch already exists:** the lane name carries the published head it replays, so a
  collision means the same trunk head is already rehearsed against the same target. Inspect that
  lane rather than recreating it. A trunk that has since advanced produces a different name, and
  the stale lane stays in place as evidence.
- **A stable snapshot already exists:** it is immutable. Inspect the existing branch and issue; do
  not force-update it. A corrected candidate needs an explicit maintainer decision and a new record.
- **A blocked issue remains:** use the skill's unblock entry point. A clean automerge is still a
  semantic review surface, and a fork commit is retired only by a recorded human decision.
- **Stable release fails:** leave the candidate issue open, fix the workflow or runner, and rerun the
  failed release. Do not move or replace the tag after a release has been published.

## Version ordering caveat

Semver precedence is global even though the updater separates channels. For example,
`0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2`. That does not promote a nightly
to stable: the desktop update-channel resolver keeps fork nightlies on the nightly feed and stable
fork releases on the stable feed. Do not infer channel or release recency from one mixed semver sort;
filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
