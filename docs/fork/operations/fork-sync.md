# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

`hyprws upstream sync` is the normal upstream-sync operator.
It mirrors upstream, picks the newest release tag the fork reaches cleanly, verifies a full replay, and publishes per mode.
A maintainer intervenes only to resolve a block, enable trunk rewrites, or cut a stable release.

Discipline lives in [Fork development](../internals/fork-development.md); gated procedures in the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill.

## Model

`hyprws` is the single fork trunk.
The bot scans only through the newest stable or nightly tag on the first-parent lane, never an untagged `upstream/main` head.
Its base is the newest clean tag inside that horizon, stable winning a tie.
It never merges upstream in, and never drops, squashes, reorders, or rewords a fork commit.

Each scheduled, pushed, or dispatched run:

| #   | Step                                         |
| --- | -------------------------------------------- |
| 1   | Fast-forward the `main` mirror               |
| 2   | Pick the newest clean tag in the horizon     |
| 3   | Snapshot every stable tag its walk crosses   |
| 4   | Replay and verify the whole stack            |
| 5   | Publish per `HYPRWS_AUTO_REBASE`             |
| 6   | Upsert candidate and `rebase-blocked` issues |

No newer clean tag is a successful no-op.
The sequential census decides: zero conflicting fork commits advances, one or more confirms a block at the pairwise scan's first conflicting upstream commit.
A failed or limited census falls back to pairwise and records why.
A confirmed block still allows an earlier clean target; a conflict past the horizon is not a block.

## Auto-rebase modes

`HYPRWS_AUTO_REBASE` is unset (`candidate`) or one of:

| Value       | Behaviour                                                |
| ----------- | -------------------------------------------------------- |
| `off`       | Mirror and report. No ref rewritten; issues still upsert |
| `candidate` | Publish the verified stack to `hyprws-next` only         |
| `on`        | Save `hyprws-previous`, rewrite `hyprws` under a lease   |

In `on` mode a landing that triggers a rebase produces two nightlies by design.
The mode governs the bot only: an unblock apply snapshots and announces the stable tags it crosses in every mode, because those tags leave the bot's window the moment it lands.

### Which walk modes publish, per ref

Rehearsing past a conflict writes a local churn row and touches no remote ref.

| Walk                                 | `hyprws` | `refs/fork/churn` | `refs/fork/rerere` | Comments |
| ------------------------------------ | -------- | ----------------- | ------------------ | -------- |
| `unblock-auto`, `off` or `candidate` | no       | local row         | no                 | no       |
| `unblock-auto --bot-carried`         | yes      | yes               | yes                | yes      |
| `record-decisions`                   | no       | yes               | yes                | yes      |
| `unblock-apply`                      | yes      | yes               | yes                | yes      |

An unblock never moves `hyprws-previous`, `hyprws-next`, or a release ref.

### Carried unblock walk

In `on` mode the carry job restores rerere from `refs/fork/rerere`, then walks non-interactively:

```bash
node scripts/fork-sync.ts unblock-auto --bot-carried --target <newest tag beyond the block>
```

| Exit | Meaning                                       |
| ---- | --------------------------------------------- |
| 0    | Applies under its own lease, posts the record |
| 2    | A legal stop, surfaced on the block issue     |
| 3    | A precondition refused. Nothing written       |

Exit 2 has exactly two reasons, written to `walk.stop` and the issue.

- **`environment`:** the lane cannot test
- **`conflict`:** doctrine reserves it for a human

`conflict` covers an undecidable row, failing scoped repairs, an unhealthy-replay scan finding, and workflow drift needing adaptation.
Anything else halting the walk is a bug in the walk.

`--bot-carried` requires `GITHUB_RUN_ID`, mode `on`, and the bot's last recorded run being this run, so it never takes another run's lease.
The carry job injects the mode, because a job token may not read repository variables; an injected mode wins.
A carried walk mints its lane with `git worktree`, which a runner can install.

Rerere is written back after every carried walk and leased apply, under at most three expected-old leases.
A different resolution at one cache path refuses publication without replacing either.
Transient `thisimage` files and the regenerated lockfile are excluded.
Failed publication exits nonzero with the snapshot retained; rerun `unblock-auto --report <report>`.

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

`refs/fork/*` is append-only and never rebased, so walk data never enters the fork series.

```bash
git fetch origin '+refs/fork/*:refs/fork/*'
git show refs/fork/churn:fork-churn.json
```

### Churn ledger

Authoring scans read `refs/fork/churn`; `--ledger-ref refs/fork/<name>` selects another.
Every scan prints the ref, exact SHA, and `current`, `stale`, `offline`, or `unavailable`.
An online read checks origin before and after reading immutable objects, so a moving remote never reports current.
`--offline` queries nothing and says so.
SHAs and ordinary branches refuse before Git runs; read a snapshot with `git show <full-sha>:fork-churn.json`.

- **`--push`:** leases the advertised ref
- **Absent, moved, diverged:** refuses with all SHAs
- **No `--push`:** local only, no remote query

Only verified current evidence passes report policy.
Stale, offline, unavailable, or unresolved-blocking evidence records `report-policy: failed` separately from publication while the run stays green, and the limitation stays visible.

#### Census evidence

The scan reconciles legacy walks and frozen v2/v3 observations against `docs/fork/internals/fork-churn.md`.
Unmapped lessons stay unresolved, and a mapping names exact integration paths, not whole-file ownership.
Neither absence, a boundary recommendation, nor a recorded guard proves repair.

A blocked report separates sequential replay from pairwise overlap.
Continuation takes the fork-side stage with rerere off, so hunk counts are unknown, not zero.
`sequential-census-v2` records each row's shape: `hooked` on manifest keys, `woven` on location, `addition` fork-owned.
An unprovable seam records `woven`, over-counting rather than flattering the fork.

A walk and its frozen copy share one immutable observation identity, and order inside each history is kept.
Several possible orders, or contradiction, makes repair assessment unavailable and fails live policy.
Neither source is assumed newer for its origin.
A newer schema keeps compatible fields visible with a partial-reader notice.

#### Recording a seam

The v3 ledger holds `walks`, immutable `seamRecords`, and target `outcomes`.
Legacy arrays and v2 envelopes stay readable; no migration invents repairs or successes.
Freeze a seam's census and reviewed mapping before rewriting it:

```bash
vp run fork:churn record --input reviewed-seams.json --push
```

`record` validates an attested bundle and never runs a named guard.
`--push` starts from the advertised ledger, so an overtaken checkout records on a normal rerun.
Malformed input leaves the ref untouched.

A bundle is `{ "version": 1, "records": [...] }`.
Each `id` is the SHA-256 of the canonical payload from `seamRecord(payload)` in `scripts/lib/fork-churn-seams.ts`.
References use record IDs and zero-based row indexes, so observations import before their rows are cited.

| Record         | Required content                                       |
| -------------- | ------------------------------------------------------ |
| `observation`  | `method`, `tag`, complete `files`, `evidence`          |
| `mapping`      | One `from: {observation, row}`, `to` rows, attestation |
| `repair`       | `before` row, `changeSha`, `guard`, attestation        |
| `verification` | `repair`, `after`, attestation, `guardProof`           |

An attestation is `{actor, evidenceUrl}` naming the reviewed record.
A `guardProof` is `{sourceSha, command, exitCode, output}` whose source must match the frozen head.
A changed target, base, method, or partial replay stays non-comparable even with a passing guard, and an attested failure always blocks.
The importer validates evidence and source binding, executing nothing.

`compose` builds a bundle from local artifacts, so evidence is produced, not typed:

```bash
node scripts/fork-churn.ts compose --plan reviewed-seams-plan.json --out reviewed-seams.json
```

Each observation names an `alias` and the `census` a sequential rehearsal wrote.
The composer freezes it whole, refusing a count-only census, a target tag disagreeing with its evidence, or a missing or contradicted `truncated` flag.
Composing writes a file for review; `record --input` stays the only import path.

**Legacy bridge** (RSI-Software/t3code-hyprws#654).
A repair whose `before` row was last seen by a `legacy-pairwise-feasibility` walk reaches `verified-repaired` when `after` is complete under the current method and `repair.changeSha` is an ancestor of `after.evidence.sourceSha`.
Guard-proof binding is untouched; the report marks the row `bridged: legacy`.

#### Seam states

| State               | Meaning                                    | Exit       |
| ------------------- | ------------------------------------------ | ---------- |
| observed            | Seen, no verified repair                   | 0          |
| not-observed        | Absent from the latest census              | 0          |
| unknown             | Partial, incompatible, or stale pre-repair | 0          |
| returned-unresolved | Seen again without comparable proof        | 1          |
| repair-unverified   | Change and guard named, no evidence        | 1 or prior |
| verified-repaired   | Clear comparable replay, guard passed      | 0          |
| regressed           | Conflicting evidence or guard failure      | 1          |

An ordinary replay keeps path, subject, and domain identity despite changed SHAs; reviewed mappings keep it through renames, moves, and splits.
Chains resolve independently of bundle order; cycles and multiple roots refuse.
A method change keeps identity but cannot establish absence or return until observed under the new method, except through the bridge.
A census bound to the frozen pre-repair head is stale, not a later regression.
A blocking verdict needs comparable repair verification to clear, except a verified repair carried across a base move (RSI-Software/t3code-hyprws#658).

#### Target outcomes

`vp run fork:churn outcome` records each selected tagged upstream commit once, retaining separate attempts under it.
Eligibility defaults true even in `candidate` or `off`, on a blocked target, or when recovery needs an agent.
An exclusion needs an explicit tag-policy reason before measurement; a mode change or rewrite cannot exclude an existing target.

```bash
vp run fork:churn outcome --auto-report <auto.json> --report-receipt <receipt.json> --push
vp run fork:churn outcome --sync-report <sync.json> --push
vp run fork:churn outcome --input reviewed-outcomes.json --push
```

Auto, rehearse, check, and apply retain a local `.outcome.json` sidecar, conflict stops and failed verification included.
List, orient, review, and refresh create no attempt.
Collectors refresh the report before reading its sidecar, so an old sidecar cannot hide a later apply.
Set `FORK_OUTCOME_EXECUTOR=agent` or `human` before an operator invocation, or the executor stays unknown.
`FORK_OUTCOME_EXPORT` saves an importable bundle before publication.

An input bundle is `{ "version": 1, "receipts": [...] }`, ordered target, attempt, stage.

| Receipt        | Names                                                                          |
| -------------- | ------------------------------------------------------------------------------ |
| Target         | `target: {tag, sha}`, `eligible`, `reason`. First tag immutable                |
| Attempt        | `targetSha`, `attemptId`, `sourceSha`, `trigger`, `executor`, `mode`, `runUrl` |
| Stage          | Target, attempt, `stage`, `status`, `detail`, actual `sha`                     |
| `target-alias` | `targetSha`, `tag`, `reason`, for a second tag on one commit                   |

Duplicates add nothing; conflicting evidence exits 1, and an older artifact never replaces the ledger.
Writes group targets by upstream ancestry, oldest first, keeping declaration order inside a target.
Missing or incomparable target commits refuse rather than silently reorder streak chronology; fetch upstream tags and `main` before a manual import.

A walk row carries `elapsedMs` from the report and `effort` from the handoff attestation, rendered absent when unavailable, never guessed.
`effort` is decoration, never a gate, so a delegated walk records none (RSI-Software/t3code-hyprws#1090).
`verify-cost` fails when any entry in the trailing five-walk window lacks `elapsedMs`, and runs as an advisory `rebase` step.

The release workflow's `always()` outcome job passes job results through `FORK_RELEASE_NEEDS` to `outcome --release --push`.
It resolves the nearest retained applied ancestor, verifies the release tag's commit, and compares every expected asset against GitHub's published name, size, and digest.
Failed preflight, build, or publication stays visible; rerun the release workflow to recover distribution without replaying an apply.

`noAgentCarry` counts consecutive eligible targets carried by on-mode bots, automatically triggered, verified, applied, and free of blocked, unknown, pending, or failed stages.
Every successful apply retains selection, verification, apply, rerere, and cache-export receipts.
A direct clean replay marks cache stages `not-attempted` with `notApplicableReason: "direct-clean-rebase"`.
Missing historical evidence never counts as success.

#### Seeding and migration

The ledger moved off `docs/internals/fork-churn.json` onto `refs/fork/churn`.
`docs/fork/internals/fork-churn.md` is a frozen mirror; RSI-Software/t3code-hyprws#476 retires both at a later rebase.
Seed the ref once, from a clean canonical `hyprws` checkout:

```bash
node scripts/fork-churn.ts seed --from docs/internals/fork-churn.json --push
```

Mutations refuse a missing ref, and scans report unavailable lesson evidence rather than an empty ledger.

A ledger seeded before census subjects became durable needs one `migrate-subjects --push`, from a checkout whose object store still resolves every census SHA.
Pruned fork-nightly refs cannot restore those commits, so a fresh fetch will not help.
The all-or-nothing guard resolves every missing subject before moving the local ref, then pushes under an exact lease.
A failed leased push restores the local ref exactly; never replace a rejected lease with an unleased force push.

`unblock-apply` appends its row and publishes the ref in the invocation that moved the trunk, so `append ... --push` is only for a row no apply wrote.
Each report run replaces a `## Churn` section on the open block issue, so the issue carries one live view.

## Regenerable files

Lockfiles, generated indexes, and version stamps carry no reviewable fork intent.
A sync keeps the new base's version and runs the registered generator after applying the fork's source inputs.
It never 3-way merges generated entries and never treats a rerere result as a resolution.

| Path             | Generator                    | Rebase rule                                                       |
| ---------------- | ---------------------------- | ----------------------------------------------------------------- |
| `pnpm-lock.yaml` | `vp install --lockfile-only` | Restore from `HEAD`, resolve sources, regenerate, stage, continue |

During a rebase `HEAD` is the base plus replayed commits, so restoring from it discards the old fork lockfile.
Re-run the generator on the completed replay when either side changed a manifest or the lockfile.
No index or stamp is registered yet; add one only with its deterministic generator and a row here.

`vp run fork:lockfile` proves the same regeneration on a feature branch, before a lockfile reaches a stop.
It refuses an uncommitted lockfile, reruns the generator, compares drift classes, and restores committed bytes either way.
Only `importers` drift fails it, because the generator re-resolves every open range and unrelated transitive pins move on the registry's schedule.

## Reading a bot run

Open the latest run and read the **Auto-rebase** job summary, not just the conclusion:

```bash
repo=RSI-Software/t3code-hyprws
run_id="$(gh run list --workflow hyprws-upstream-sync.yml --limit 1 \
  -R "$repo" --json databaseId --jq '.[0].databaseId')"
gh run view "$run_id" -R "$repo"
gh run view "$run_id" --log-failed -R "$repo"
```

The summary emits exactly: mode, status, old head, base, target, rebased head, candidate count.
Status is `off`, `no-op`, or `advanced`.
A remaining block adds **Blocked beyond the clean window** with the first conflicting upstream commit, remaining commit count, and newest later tag.

The replay still verifies commit count and messages, the fork ledger, `vp check`, and typecheck before any push; the summary just does not itemise them.
Conflict tables and affected fork commits live in the `rebase-blocked` issue.
In candidate mode, compare the rebased head with `git rev-parse origin/hyprws-next`.

A green run with a block issue means the bot advanced as far as it safely could, not that the whole upstream lane was clean.

### Block issue lifecycle

At most one `rebase-blocked` issue is open, identified by the exact `blocking-sha` body marker.
A blocking SHA is filed once, including after a manual close.
When the first conflict changes, the bot closes the old issue by identity before creating a new one.
The workflow concurrency group is the single writer, and dedupe assumes the marker and label stay intact on every open or closed block issue.

While blocked, each run silently rewrites the body without changing the title.
One **Refresh log** comment draws the tagged horizon: `o` commit, `X` block, `N` nightly tag, `S` stable tag, `Nc` conflicting fork commits to that tag.
The bot edits it in place, appending a row only when the newest tag past the block changes.
The issue is assigned on creation and commented on close; those are the only human notifications.

## Unblocking a `rebase-blocked` issue

Run from a disposable worktree off the trunk (`git worktree add --detach <dir> origin/hyprws`), after one `node scripts/setup-worktree.ts`.

`vp run fork:sync unblock-auto [--target tag@sha] [--report <path>]` walks one eligible tag to the end in one invocation.
It selects the target, accepts a coherent orientation, resolves every conflict, repairs the lane, runs the guards, applies under the existing lease, appends the churn row, and records the apply's push as the reconciliation trigger.
That push starts the next run, which the walk does not wait for.
It asks nothing on the way and takes no `--resume`: a report on disk is a walk in flight, picked up where it stopped.
If `origin/hyprws` moves under it, it re-lists from the moved trunk once by itself.

### Walk pause

Set candidate mode before a walk and leave it there until the series ends:

```bash
gh variable set HYPRWS_AUTO_REBASE --body candidate --repo RSI-Software/t3code-hyprws
```

No second run is needed after an apply: the leased push is the trigger.
Confirm the blocked issue closes with `Resolved by hyprws <sha>` and the next opens, or that none remains.
Restore `on` only when the series is complete; deleting the variable restores the candidate default.

### Conflict doctrine

Conflict resolution is machine-owned.
Each conflicted path goes to shared rerere first; the remainder goes to the outcome executor, which reads the three index stages and applies doctrine in order:

| #   | Rule                                            |
| --- | ----------------------------------------------- |
| 1   | Only upstream moved, so upstream's text stands  |
| 2   | Only the fork moved, so the fork keeps working  |
| 3   | Both moved, keep both, if every hunk co-inserts |

There is no "upstream superseded this" rule.
Gate 4 keeps every candidate, so taking upstream's side of a kept commit's files would keep the commit and drop its behaviour.
Retiring a fork commit stays a human decision in `docs/fork/internals/fork-delta.md`.

The fork is additive, so these refuse rather than stage, each becoming the `conflict` stop:

- **Dropping a line upstream added:** never
- **A seam both sides rewrote:** says two things
- **No common ancestor:** add/add, rename, delete
- **Binary files:** no hunk model

### Additive proof

First the walk proves the replayed tree purely additive over the target: no target file deleted, no migration deleted or renumbered into a collision, no upstream test shrunk, no upstream-deleted line re-added.
It repairs a failure once in the same `Fork-Repair` commit, by restoring from the tag, renumbering a colliding fork migration, or dropping re-added lines.
A shape the fix refuses, such as a shrunk test or a brace-unbalanced re-add, is the `conflict` stop, because only a human can say which side to keep.

`off` and `candidate` still suppress the trunk push, so a walk in either mode is a dry run ending at the report.

### Lane repair

Repair runs in the same invocation, scoped to what the replay touched.
The formatter runs over the resolved paths and every repair commit before the proofs.
Then `typecheck` per touched workspace, focused tests beside the touched sources, and every fork-owned `*.fork.test.{ts,tsx}` in the lane.
Formatted repairs commit before the additive gate, which reads HEAD; if the commit-time formatter rewrites anything afterwards, the battery reruns once and later drift is a stop.
There is no full battery in the lane and no wait on a remote verdict, because trunk CI confirms after the apply.

- **Tools cannot run:** the `environment` stop
- **A repair fails on merit:** the `conflict` stop

Before the scan proof, the check repairs reviewable workflow drift: a fork side byte-identical to the last review commits a refreshed reviews entry as its own fork-meta repair.
Drift needing human adaptation stops the walk with that drift as its surface and the reviews path in its allowance.
An actionable `fork:scan` failure is likewise the `conflict` stop.

Whatever a repair rewrites becomes a `fixup!` to its owning fork commit, autosquashed during the check; an ownerless path needs `--seam-owner '<path>=<full owner sha>'`.
The check reports `checked` only after proving the landed tree equals the tested tree and re-proving the replay and fold segments.
A conflicted autosquash aborts and restores the lane head.

### Decision records

Every walk keeps one durable record per decision (RSI-Software/t3code-hyprws#662).
Executor decisions and rerere replays land on the report's `## Decisions` as they happen; a stop records the rows it hands to a human.
The stopped session resolves and stages the seam, then runs `fork:sync record-decisions --report <json> --tag <tag>`, which flushes the resolution into shared rerere, posts the record to the blocked issue, and writes the stopped tag's ledger row as `pending`.
The next walk resolves the same content from that record, naming its source walk and outcome, and the applied row upgrades the pending row in place.
No maintainer decides one seam twice.

The report is an operator-owned state file, not a signature.
The command proves the active runtime identity and binds it to the record, refs, CI head, and lease.
An operator able to rewrite the report can fabricate its contents: the control is procedural provenance and stale-state detection, not protection from a malicious local operator.

Retirement remains human.
A walk may resolve a seam upstream now carries, but only a `retire` verdict in the fork delta ledger drops a commit from the stack.

### The fold rule

A walk leases `origin/hyprws` at its `expected_old` (frontier B) but does not freeze landings.
A landing that advances the trunk linearly folds.
At `replayed` or `checked`, `unblock-fold` replays `B..live` onto the candidate with fixed SHAs, proves the segment, advances the frontier, and regresses the walk to `replayed` so `unblock-check` reruns the final-tree gates.
`unblock-apply` folds and retries the same way, bounded to three attempts, when its leased push is rejected as stale.
A `conflicts` walk holding its lane but not yet replayed defers the fold instead of voiding.

Movement that cannot fold voids the rehearsal and costs the full replay: a merge commit, a rewritten trunk, a moved shared base, or a moved target.
A tooling fix the walk needs goes into the walk's lane or a branch the walk rehearses against, never onto `hyprws` mid-walk.

### Verb ladder

`unblock-auto` runs these in one invocation.
The verbs stay callable for diagnostics, for picking up a stopped walk, and for the series rewrite.

| #   | Verb and contract                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `unblock-list` fetches, preflights, requires one current block, and writes a report with the full blocking SHA and selectable tags. It takes no target and offers only the newest; `--all` lists every one                                                      |
| 2   | `unblock-orient` consumes that report after a human selects a tag, proves the tag was offered and is beyond the block, and pins target, shared base, and one `expected_old`                                                                                     |
| 3   | `unblock-rehearse` creates or resumes the bound lane. A stop names the in-flight commit, every conflicted path, and each reused rerere resolution, so the human reviews rather than authors. `pnpm-lock.yaml` takes the [regeneration rule](#regenerable-files) |
| 4   | `unblock-check` classifies post-replay lock drift, installs at the replay head, and runs the fork scan and ledger locally                                                                                                                                       |
| 5   | The walk fills the decision surface rather than asking: every row is decided, a candidate is kept whether or not the target already carries the work, and a human-filled cell beats a rerun                                                                     |
| 6   | `unblock-review` belongs to the series rewrite. It signs a `checked` report, binding record, target, blocking SHA, `expected_old`, installed and CI head, and rehearsal branch to the reviewer's session. A withheld review is durable                          |
| 7   | `unblock-apply` calls `fork:sync-gate`, posts the record, snapshots every stable tag it crosses, applies under the lease, then announces. Snapshots go first because a create-only branch stands alone; a failed announcement never voids the apply             |

Every rehearsal Git call carries `core.commentChar=auto`; rebase calls enable rerere with index autoupdate disabled.
The step 4 scan pins to the tag the stack sits on, so a moved `upstream/main` cannot fail a lane for drift it did not introduce.
Record a repaired seam with `--silent-seam '<path>=<summary>:type'` or `:behaviour`.
The check proves the lane's delta with the tooling checkout's `fork-delta`, so a gate fix applies to a lane in flight without a fold.

Lock drift is classified before the scan.

| Drift          | Owner rule                                                                                |
| -------------- | ----------------------------------------------------------------------------------------- |
| Snapshots only | No owner. Restore the replayed lockfile                                                   |
| Importer       | Newest non-repair commit in range introducing the moved specifier, carrying both trailers |

The check throws, naming the conflict, when no commit owns a moved specifier, when more than one does, or when `vp i` reintroduces importer drift.
A series rewrite always throws here rather than committing, because its head is a constructed manifest result.
Rerunning the check on a `checked` lane re-renders seams and rebinds the head; declared seams replace recorded ones by path, and refreshing invalidates prior CI and review evidence.

Each verb consumes the previous verb's JSON report and atomically advances it; no shell variable carries gate state.
Report and record stay outside the repository, and new rehearsals never add to `docs/fork/operations/fork-sync-records/`.
Every transition refuses stale refs, wrong lanes, incomplete rows, changed messages or counts, unowned or ambiguous importer drift, failed checks, and a missing, stale, same-session, or withheld review.
A successful leased push starts the run that reconciles the resolved blocking SHA.

### Series rewrite review

The **series rewrite** is a separate human-driven lane rewriting the whole stack at once.
Only it pushes a rehearsal lane, waits on a CI verdict, and needs a second session's review before apply.
It waits up to 45 minutes, polling every 30 seconds; a timeout or completed red run fails the gate with the run URL, id, conclusion, failed job names, and a capped ANSI-stripped log tail.

The rewriting host hands the report and record paths to a reviewer in another session.
The reviewer inspects the generated target, live blocking marker, every non-mechanical verdict, rehearsal evidence, pushed-lane CI on the exact installed head, every silent seam, and the live lease, then records one verdict:

```bash
vp run fork:sync unblock-review --report <report> --sign-off
vp run fork:sync unblock-review --report <report> --withhold '<reason>'
```

The command records interface, provider, model, and session for proposer and reviewer, reading each from `ghb attest handoff` in the active runtime.
Never copy a handoff between sessions or edit those fields into a report.
Sign-off is withheld for undefined fork intent, a non-equivalent retire, a user-visible behaviour change, a domain or tier topology change, any bypass, or unverifiable evidence.

Apply names this the **nightly review gate**: one recorded verdict on a `checked` report.
`unblock-apply` runs `fork:upstream-refs` on the record before the gate, so a refs-only prose fix on the same bindings keeps the verdict.
It refuses a missing or withheld review, a verdict from the proposing session, any change to reviewed bindings, moved rehearsal or CI heads, and a moved lease.
The digest binds header bindings, conflict and decision rows, silent-seam verdicts, and verification lines; free prose never enters it.

The unblock walk is not subject to this gate.
It carries no agent judgement to review: outcomes come from doctrine the code applies, and its two stops escalate only what doctrine reserves for a human.

## Historical rewrite construction

`vp run fork:sync rewrite-build --manifest <reviewed-json> [--json]` builds an exact same-base history from materialized, reviewed snapshot changes.

| Boundary    | Rule                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| Never       | Interprets AST recipes, fetches, touches index or worktree, moves refs, publishes |
| Writes      | Unreferenced objects and `<manifest>.receipt.json`                                |
| Determinism | An identical rebuild returns identical object IDs and bytes                       |
| Receipt     | A different existing receipt refuses replacement                                  |
| Artifacts   | Manifests and proofs stay outside the checkout and out of commits                 |

The executable schema is `fork.rewrite-manifest.v1`.
Unknown fields, abbreviated object IDs, design-only schemas, and a nonempty `unresolved` refuse.

| Field                                     | Contract                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`, `sourceTree`, `base`, `baseTag` | Exact SHA-1s. Source must match the retained `origin/hyprws`; the constructor is offline, so verify the advertised trunk first                                                                                             |
| `proofs`                                  | Unique `{name, artifact, sha256}`, one each of `snapshot-tests`, `composition`, `test-ownership`, `compatibility`. Gates re-hash the JSON and require `fork.rewrite-proof.v1`, matching name and source, `verdict: "pass"` |
| `expected`                                | Reviewed `changedSlots`, `unchangedSlots`, `removedSignatures`. Changed plus unchanged cover the stack; construction recomputes all three                                                                                  |
| `unresolved`                              | Empty. An unfinished proof is not executable                                                                                                                                                                               |
| `overrides`                               | Present only for an operator-chosen fold part: `attributed`, `left`, `unused`. Absent means no change may carry `origin`                                                                                                   |
| `slots`                                   | Every original commit once, in order, with `commit`, `tree`, `resultTree`, `readSet`, `changes`. Empty cleanup commits remain slots                                                                                        |
| `readSet`                                 | `{path, entry}` for the whole read set, every changed path included. `entry` null for absence, else `{mode, type, oid}`                                                                                                    |
| `changes`                                 | `{path, before, after, reason}`, plus `origin` on every change when `overrides` is present and none when absent. Duplicate paths refuse                                                                                    |

### Reading an overrides record

An `overrides` record is reviewed evidence, not a derivation.
`fold-reshape --attribute` and `--leave` are the only parts of a fold nothing derives, and a rewrite stays tree-neutral whichever slot absorbs a change, so no proof catches a wrong attribution.

```bash
jq -r '.overrides | (.attributed[] | "attribute \(.path)=\(.commit)"), (.left[] | "leave \(.)"), (.unused[] | "unused \(.)")' manifest.json
```

`unused` carries every flag that had no effect, as typed.
Read the record as "a human passed flags here", not "a human moved a change".

### Trees the constructor accepts

Supported entries are ordinary and executable files, symlinks, and gitlinks with exact Git modes and types.
Undeclared entries are preserved, and every expected output tree is validated before an object is written.
The final full tree must equal the frozen source, tests and non-test harnesses included.
A donor tree never replaces a whole combined snapshot: materialize only its declared path changes alongside the other active transforms.

On a pushed `rehearse/rewrite-*` branch, fork CI treats the stack as historical authoring only after `fork:scan` proves the candidate's full tree equals `origin/hyprws`.
Every other branch is offered `--replay-of origin/hyprws`, reaching that verdict only after the scan proves the head omits the trunk and sits on a tagged upstream commit the trunk has not reached.
An ordinary pull request fails that proof and keeps its normal authoring range.

### What is preserved and what refuses

Raw message and identity bytes, timestamps, timezones, and ordered parent correspondence are unchanged.
A rewritten signed commit loses only the now-invalid `gpgsig` header, its digest retained in the receipt.

| Refuses                                                    | Why                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| Merges, shallow repos, grafts, odd headers, non-UTF8 paths | Outside the supported model                           |
| Explicit empty subtrees                                    | The flat path model cannot preserve them              |
| Partial or promisor config, promisor packs, alternates     | Git 2.43 can otherwise fetch missing objects mid-read |
| A nonempty `GIT_CONFIG`                                    | It can redirect the metadata probe silently           |

### Artifact and exit boundaries

A read-only verifier recomputes the receipt from manifest and objects at the governed gates.
Manifest, adjacent receipt, and every proof must be regular files outside the checkout, with no symlinked parent redirecting them into it.
Build, rehearsal, check, review, and apply share this validation before traversal or writes.
`--json` emits one complete ANSI-free result or error object, and help performs no work.

| Exit | Meaning                                 |
| ---- | --------------------------------------- |
| 0    | Verified                                |
| 1    | Runtime failure                         |
| 2    | Usage or schema error                   |
| 3    | Stale or unsupported proof precondition |

### Why every gate rebuilds

`rewrite-rehearse`, `unblock-check`, `unblock-review`, and `unblock-apply` each recompute the whole construction instead of reading the receipt.
The receipt is an unsigned external file, editable by whoever edits the manifest; `verifyRewriteBuild` builds a fresh one and compares, so the rebuild is the verification.
Re-hashing manifest bytes and proving each `resultTree` exists is strictly weaker: a receipt naming any existing tree would pass.
This ladder is the only thing between a reviewed manifest and rewritten published history, and a 275-slot build runs in under five minutes.

Pause the bot for the series, then:

```bash
vp run fork:sync rewrite-build --manifest /external/reviewed.json --json
vp run fork:sync rewrite-rehearse --from <receipt-result-sha> --manifest /external/reviewed.json --issue <live-block>
vp run fork:sync unblock-check --report <emitted-report>
vp run fork:sync unblock-review --report <emitted-report> --sign-off   # another session
vp run fork:sync unblock-apply --report <emitted-report> --record <emitted-record>
```

The lane binds its exact receipt, existing base tag, real blocking marker, and retained base outcome declaration, refusing relaxed proofs and a different issue.
A changed candidate needs a new manifest and proposal; a source movement voids the proposal.
An unbound report is inspectable through `rewrite-rehearse --dry-run`, never checked or published as a constructed rewrite.
A same-base apply does not resolve the upstream blocker: start a fresh tagged walk and keep its seam and distribution proof separate.

`rewrite-rehearse` binds the old trunk to `archive/hyprws-pre-rewrite-<12-char expected-old>`.
Rewrite-kind `unblock-apply` creates it under an explicit missing-ref lease, reads the remote SHA back, and retains the binding before the record is posted or `hyprws` moves.
A rejected trunk lease keeps the archive as failed-attempt evidence.
The rewrite never moves `hyprws-previous`.

## Cut a stable release

Every stable snapshot gets one `release`-labelled `Notification 🔔` issue, whichever lane created it.
That issue is the whole entry point: a fresh session needs it and nothing else.

Exactly one candidate is open at a time.
Each reconcile closes a candidate whose release tag is already on `origin` as completed, and one an open newer candidate overtook as not planned.
Only the newest un-cut candidate survives, so the issue `stable-list` offers is the live one.

Invoke the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill at its **cut stable** entry point.
The lane is three external-report transitions; no shell variable or pasted command block carries gate state.

**1. `stable-list`** preflights, reads every open candidate, validates title, body, and marker, and writes a selection report.
It accepts no issue number: a human selects one, and recency is not permission to infer it.
The `<!-- hyprws-stable-candidate: <name> -->` marker is the identity; a trailing `ghb`-owned homing marker on the title is accepted, never stripped or hand-written.

**2. `stable-prepare --report <report> --issue <selected-issue>`** rereads the exact issue, fetches its snapshot and tags, binds the remote commit, and creates the collision-refusing `cut/vX.Y.Z-hyprws` lane.
It installs with the lockfile frozen, then runs `fork:delta --check` through that lane's binary and project environment.
The `check`, typecheck, and test verdict comes from `hyprws CI`, never the operator machine: prepare reverifies the pushed head, waits up to 45 minutes for the run on that exact SHA, and records `hyprws CI <run-url>`.
A failed job or timeout fails prepare with the run URL and bounded log evidence before any UAT draft renders.
It derives the next tag through the release helper, refuses a local or remote tag collision, and revalidates snapshot, clean lane, and checked head.
It calls the existing `fork:uat` dry-run surface and writes the review draft beside the report, carrying every applicable condition from the previous stable's UAT.
Tooling comes from trunk and product from the snapshot, so the canonical checkout renders that draft against the snapshot ref while content checks run through the lane.
A preparation failure synchronously removes the cut lane before requiring a fresh `stable-list`; if removal fails, the refusal prints the exact forced recovery command.

**3. `stable-publish --report <report> --go <exact-candidate>`** requires the human to repeat the candidate after UAT judgement.
It rereads the open candidate, revalidates snapshot, clean lane, and absent tag, creates the annotated tag at the exact snapshot SHA, and pushes only that tag.
It trashes the cut lane, watches the exact `hyprws-release.yml` tag run, requires an `.AppImage` and `latest-linux.yml`, then closes the candidate with tag, snapshot SHA, and workflow URL.

### Release snapshots

A release snapshot never follows later trunk work.
It is the immutable branch a human cuts a stable fork tag from.

**A stable upstream tag is snapshotted and announced by whichever lane moves the fork base past it.**
The bot sees only tags inside its own walk window, so a tag the base already passed is invisible to it forever.
An unblock apply therefore snapshots every stable tag it crosses before pushing the trunk, replaying the pre-apply stack onto each exactly as the bot would.
Each snapshot is checked for replay shape only, because `stable-prepare` runs full verification again.
A tag whose snapshot cannot be replayed mechanically is named in a warning and skipped; snapshot it by hand before cutting it.

The channels differ.
`hyprws-release.yml` fires on every push to `hyprws`, so a leased apply cuts the nightly by itself and no operator ever cuts one.
Only stable needs a candidate, a UAT cycle, and an explicit human go.

### UAT boundary

The preparation stop is the [`fork-uat`](../../../.agents/skills/fork-uat/SKILL.md) judgement boundary.
The agent reviews rendered sources and carried conditions, writes observable task drafts, and removes reviewer-only sections.
`fork:uat --prepare` compiles that review into a hashed parent tracker plus one child per acceptance condition and preflights every filing.
The agent shows the exact bundle to the human; only an explicit human go permits `fork:uat --create`.
The human runs the candidate, closes each passing child, and leaves follow-up work open with its findings.
A `Signed off` parent comment is recommended on acceptance, but neither it nor complete child closure is an automatic publication gate.

Normal rendering omits `--since`; `fork:uat` selects the newest eligible stable tag for the candidate's base.
`--since` is an explicit historical or human-directed override, marked `(overridden)` in the snapshot.
The new parent links the previous UAT, and carried children link their exact previous acceptance task.

### Stable sign-off stop

Present the selected issue, snapshot branch and SHA, derived tag, prior matching tags, all preparation results, the clean and ref checks, and the UAT evidence.
If the app cannot launch or basic use fails, the human withholds the release go.
Ordinary open children, polish findings, and a missing parent sign-off stay non-blocking evidence.
An inexact candidate or go, stale snapshot, dirty or moved lane, issue change, tag collision, failed push, failed workflow, or missing asset refuses advancement.
Never increment again after a refusal without returning to `stable-list` for a fresh human go.

The issue close, immutable tag, workflow run, and GitHub release are the record.
Do not add a human sync record for an ordinary bot snapshot.
An `upstream-watch` issue closes only after the released build carrying its fix is installed or run and the behaviour verified.

## Recovering local lanes after a rewrite

Feature lanes start from `hyprws`, never `hyprws-next` or a `release/*` snapshot.
`hyprws-next` is an inspection ref: after the mode flips to `on` it stays at the last candidate push and goes stale.
Release snapshots are immutable release inputs.

`hyprws-previous` does not exist until the first on-mode run.
For that first rewrite, take the full old head from the **Auto-rebase** summary as the old boundary:

```bash
git fetch origin hyprws
git rebase --onto origin/hyprws <old-head> <feature-branch>
```

Once `hyprws-previous` exists, a branch based on the immediately previous trunk uses the ref directly:

```bash
git fetch origin hyprws hyprws-previous
git rebase --onto origin/hyprws origin/hyprws-previous <feature-branch>
```

Inspect the range first if the lane was not based on that boundary; never guess an `--onto`.
A lane based on `hyprws-next` or `release/*` needs its real merge base inspected and cannot use the generic command.

The canonical `hyprws` worktree carries no independent commits, so reset it with `git reset --hard origin/hyprws`.
Never run that in a feature worktree or over uncommitted work.

## One-time repository setup

### Bot token

Create a fine-grained token owned by the automation actor, limited to this repository:

- **Contents:** read and write, for pushes
- **Workflows:** read and write, for mirrors

Mirror, candidate, snapshot, and leased trunk pushes need Contents; mirrored commits can change workflow files.
Store it as the `HYPRWS_MIRROR_TOKEN` Actions secret.
The workflow uses its own `GITHUB_TOKEN` with `issues: write`; do not widen the personal token.

### Labels

The workflow force-creates `rebase-blocked` every run, overwriting a drifted description:

```bash
gh label create rebase-blocked --force --color B60205 \
  --description "The fork stack conflicts with newer upstream history" \
  -R RSI-Software/t3code-hyprws
```

The `release` label must exist before the first stable snapshot; the workflow does not create it.

### Which events run the fork matrix

`hyprws-ci.yml` produces every context the `hyprws` ruleset requires: `Check`, `Test`, `Test Scripts`, and three `Test Server` shards.
It runs on a pull request opened, pushed to, or reopened, on a push to a fork trunk, rehearsal, or release branch, and on `merge_group`.
It deliberately skips `ready_for_review`, because GitHub already ran `pull_request` on that exact draft head.

`merge_group` is what makes a merge queue possible: a queue builds `gh-readonly-queue/hyprws/**` and waits for the required contexts there.
Add the trigger before requiring a queue in the ruleset, never after.

### Upstream workflows and merge settings

Keep only `hyprws-ci.yml`, `hyprws-release.yml`, and `hyprws-upstream-sync.yml` enabled.
Upstream workflows stay unchanged in the tree but disabled, because they expect upstream secrets and runners.

```bash
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

The rulesets tracked in RSI-Software/t3code-hyprws#220 are applied by hand in **Settings > Rules > Rulesets**, all `active`.
This repository never applies or changes them unattended.

| Ruleset             | Targets and rules                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hyprws`            | Pull request with 0 approvals plus `Check`, `Test`, three `Test Server`. Admin always-allow bypass, and deliberately no force-push rule, because the bot must force-push |
| `main`              | Pull request, same admin bypass. Only the mirror job writes it                                                                                                           |
| `no trunk deletion` | Blocks deleting `hyprws` and `main`, no bypass actors                                                                                                                    |
| `stable tags`       | `refs/tags/v*-hyprws.*`, excluding nightlies. Blocks delete and update, no bypass actors                                                                                 |

A direct non-bypass push to `hyprws` cannot be demonstrated, because the repository has no non-admin collaborator.
Fork CI checks a pull-request body for squash-commit ledger trailers only when it is ready and based on `hyprws`.
It skips drafts and every other base, rebase rehearsals included, because those land by leased force-push.

### Runners

Both fork workflows run on `ubuntu-latest`.
`hyprws-release.yml` publishes a nightly on every landing; its six-hour schedule is a fallback that publishes only when the head differs from the newest nightly tag.
The release job keeps the newest 7 nightlies and deletes older releases with their tags; stable releases are never pruned.

The rsi-ci pool was measured and rejected: five concurrent jobs on one 12-core container reached wall times at parity with hosted at best.
Revisit only if the pool grows or the repository goes private.
`docs/runbooks/ci-runners.md` in `RSI-Software/ops` owns the pool.

| Tool             | Source                                       |
| ---------------- | -------------------------------------------- |
| Node and `vp`    | `voidzero-dev/setup-vp@v1`, workspace cache  |
| Rust and `cargo` | `dtolnay/rust-toolchain@stable`, runner home |
| ImageMagick      | On the hosted image; `apt-get` when missing  |

A missing tool is a workflow task, not a reason to patch the build script.

### Optional T3 Connect config

The fork build leaves T3 Connect dark unless all four repository variables exist:

- **`T3CODE_RELAY_URL`**
- **`T3CODE_CLERK_PUBLISHABLE_KEY`**
- **`T3CODE_CLERK_JWT_TEMPLATE`**
- **`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`**

## Failure handling

| Failure                        | Response                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Mirror fails**               | Recreate a missing or expired token. A rejected fast-forward means someone wrote `main`; never force the mirror |
| **No clean target**            | Report-only until a release tag enters the window. Never target an untagged commit                              |
| **Feasible, replay conflicts** | An automation bug. Nothing is pushed; do not resolve in the workflow worktree                                   |
| **Replay verification fails**  | Nothing is pushed. Fix fork or automation by pull request; never weaken the comparison                          |
| **Trunk lease rejected**       | Remote work appeared after the read. Inspect and rerun; never swap the lease for `--force`                      |
| **A rehearsal branch exists**  | That head is already rehearsed against that target. Inspect the lane                                            |
| **A stable snapshot exists**   | Immutable. A corrected candidate needs a maintainer decision and a new record                                   |
| **A blocked issue remains**    | Use the skill's unblock entry point. Retirement needs a recorded human decision                                 |
| **Stable release fails**       | Leave the candidate open, fix the workflow or runner, rerun. Never move a published tag                         |

## Version ordering caveat

Semver precedence is global even though the updater separates channels.
For example, `0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2`.
That does not promote a nightly: the desktop update-channel resolver keeps fork nightlies on the nightly feed and stable releases on the stable feed.
Never infer channel or recency from a mixed semver sort; filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
