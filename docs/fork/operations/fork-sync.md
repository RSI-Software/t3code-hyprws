# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

The `hyprws upstream sync` workflow is the normal upstream-sync operator.
It mirrors upstream, finds the newest upstream release tag the fork reaches without a textual conflict, verifies a full-stack replay, and publishes per the configured mode.
A maintainer intervenes only to resolve a block, enable trunk rewrites, or cut a stable release.

| Topic            | Source                                                              |
| ---------------- | ------------------------------------------------------------------- |
| Discipline       | [Fork development](../internals/fork-development.md)                |
| Gated procedures | the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill |

## Historical rewrite construction

`vp run fork:sync rewrite-build --manifest <reviewed-json> [--json]` builds an exact same-base history from materialized, reviewed snapshot changes.

| Boundary    | Rule                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Never       | Interprets AST recipes, fetches, touches an index or worktree, moves refs, changes bot mode, or publishes to GitHub |
| Writes      | Unreferenced Git objects and `<manifest>.receipt.json`, nothing else                                                |
| Determinism | A second identical build returns identical object IDs and receipt bytes                                             |
| Receipt     | An existing different receipt refuses replacement                                                                   |
| Artifacts   | Manifests and proofs live outside the implementation checkout and out of commits                                    |

The executable schema is `fork.rewrite-manifest.v1`.
Unknown fields, abbreviated object IDs, design-only schemas, and a nonempty `unresolved` refuse.

| Field                                     | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`, `sourceTree`, `base`, `baseTag` | Exact SHA-1s; source must match the retained `origin/hyprws`. The constructor is offline and cannot assert remote freshness, so refresh and independently verify the advertised trunk before freezing.                                                                                                                                                                                                                                                                                         |
| `proofs`                                  | Unique `{name, artifact, sha256}`, exactly one each of `snapshot-tests`, `composition`, `test-ownership`, `compatibility`. `artifact` is relative to the external manifest. Build and every later gate re-hash a regular external JSON file and require `schema: "fork.rewrite-proof.v1"`, the matching name and source, and `verdict: "pass"`. The rest of each proof is reviewed input evidence, not a test the constructor runs.                                                            |
| `expected`                                | Reviewed nonnegative `changedSlots`, `unchangedSlots`, `removedSignatures`. Changed plus unchanged must cover the whole stack; construction derives changed slots from tree inequality and recomputes all three before writing objects.                                                                                                                                                                                                                                                        |
| `unresolved`                              | Must be empty. Unfinished source, test, or compatibility proof is not an executable manifest.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `overrides`                               | Present only when an operator chose part of the fold: `attributed` `{path, commit}` placements, `left` paths the reshape diff carried and the fold skipped, `unused` flag text that bound to nothing. The reader binds each half to the slots (an attribution owns every change at its path and starts no later than the first slot folding it; an excluded path owns none), so neither copy can be edited alone. Absent means nothing was hand-chosen, and then no change may carry `origin`. |
| `slots`                                   | Every original commit once in original order: `commit`, original `tree`, expected `resultTree`, `readSet`, `changes`. Empty cleanup commits remain slots.                                                                                                                                                                                                                                                                                                                                      |
| `readSet`                                 | `{path, entry}` for the whole reviewed source and dependency read set; every changed path appears. `entry` is null for absence, else `{mode, type, oid}`.                                                                                                                                                                                                                                                                                                                                      |
| `changes`                                 | `{path, before, after, reason}` in that entry shape, plus `origin` (`{kind: "blame"}` or `{kind: "operator", commit}`) on every change when `overrides` is present and on none when it is absent. Compose overlapping transforms into one change per path; duplicate paths refuse. Replacement objects must already exist.                                                                                                                                                                     |

### Reading an overrides record

An `overrides` record is reviewed evidence, not a derivation.
`fold-reshape --attribute` and `--leave` are the only parts of a fold nothing derives, and a rewrite stays tree-neutral whichever slot absorbs a change, so no proof catches a wrong attribution and only a reviewer reading the record can.
Enumerate the decisions before signing off:

```bash
jq -r '.overrides | (.attributed[] | "attribute \(.path)=\(.commit)"), (.left[] | "leave \(.)"), (.unused[] | "unused \(.)")' manifest.json
```

`unused` carries every flag that had no effect, as the operator typed it.
Such a flag changes nothing the fold derives, so a run whose overrides were all unused still succeeds and says so.
Read the record's presence as "a human passed flags here", not "a human moved a change".

### Trees the constructor accepts

Supported entries are ordinary and executable files, symlinks, and gitlinks with their exact Git modes and types.
All undeclared entries are preserved, and every expected output tree is validated before any object is written.
The final **full tree** must equal the frozen source, tests and non-test harnesses included, which is deliberately stricter than the legacy rewrite diagnostic's test-file exclusion.
A donor tree never replaces a whole combined snapshot: materialize only its declared path changes alongside the other active transforms.

On a pushed `rehearse/rewrite-*` branch, fork CI treats the replayed stack as historical authoring only after `fork:scan` proves the candidate's full tree equals `origin/hyprws`; a tree mismatch fails.
Every other branch is offered `--replay-of origin/hyprws`, which reaches that verdict for a rebase rehearsal only after the scan proves the head omits the trunk and sits on a tagged upstream commit the trunk has not reached.
An ordinary pull request fails that proof and keeps its normal authoring range.

### What is preserved and what refuses

Raw commit message and identity bytes, timestamps, timezones, and ordered parent correspondence are unchanged.
A rewritten signed commit loses only the now-invalid `gpgsig` header, its digest retained in the receipt; unchanged objects keep signatures.

| Refuses                                                                                            | Why                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Merge histories, shallow repos, grafts, unsupported headers or object formats, non-UTF8 tree paths | Outside the supported model                                                                                        |
| Explicit empty subtrees                                                                            | The flat path model cannot preserve them                                                                           |
| Partial or promisor config (inherited too), promisor pack markers, alternate object stores         | Refused before traversal: Git 2.43 can otherwise fetch missing objects during a read                               |
| A nonempty `GIT_CONFIG`                                                                            | Refused before Git runs: it can redirect the metadata probe without changing the config later object commands read |

### Artifact and exit boundaries

A read-only verifier recomputes the receipt from manifest and objects at the governed gates.
Manifest paths resolve from the repository root, including from a subdirectory.
Manifest, adjacent receipt, and every proof must be regular files outside the checkout, with no symlinked parent redirecting them into it; changing, removing, or redirecting one invalidates construction and every later gate.
Build, rehearsal, check, review, and apply share this validation before traversal or writes, so copied or replaced artifacts cannot bypass it after construction.
`--json` emits one complete ANSI-free result or error object, and help performs no work.

| Exit | Meaning                                 |
| ---- | --------------------------------------- |
| 0    | Verified                                |
| 1    | Runtime failure                         |
| 2    | Usage or schema error                   |
| 3    | Stale or unsupported proof precondition |

### Why every gate rebuilds

`rewrite-rehearse`, `unblock-check`, `unblock-review`, and `unblock-apply` each recompute the whole construction instead of reading `rewrite-build`'s receipt.
The receipt is an unsigned external file, editable by whoever can edit the manifest; `verifyRewriteBuild` builds a fresh one and compares, so the rebuild is the verification and the stored copy is only a diff target.
Re-hashing manifest bytes and proving each `resultTree` exists is strictly weaker: it shows some construction produced present trees, and a receipt naming any existing tree would pass.
This ladder is the only thing between a reviewed manifest and rewritten published fork history, and a 275-slot build runs in under five minutes.

Pause the bot for the walk series, then use:

```bash
vp run fork:sync rewrite-build --manifest /external/reviewed.json --json
vp run fork:sync rewrite-rehearse --from <receipt-result-sha> --manifest /external/reviewed.json --issue <live-block>
vp run fork:sync unblock-check --report <emitted-report>
vp run fork:sync unblock-review --report <emitted-report> --sign-off   # in another session
vp run fork:sync unblock-apply --report <emitted-report> --record <emitted-record>
```

The lane binds its exact manifest receipt, existing base tag, real blocking marker, and retained base outcome declaration, and refuses relaxed count or path proofs and a different issue.
On a nightly base, apply refuses until another session records `unblock-review` on the checked report.
The record digest covers construction and outcome provenance.
A changed candidate needs a new manifest and proposal; a source movement voids the proposal.
An unbound report is inspectable through `rewrite-rehearse --dry-run`, never checked or published as a constructed rewrite.

The outcome collector reuses the base's immutable eligibility and reason and adds `rewriteProvenance` to the attempt.
It never invents a target declaration or claims an upstream advance; missing retained eligibility is reconciled from reviewed evidence first.
Check and apply failures and pending cache publication stay visible, and builder preparation is not a carry attempt.
A same-base apply does not resolve the upstream blocker: start a fresh tagged walk and keep its comparable seam and distribution proof separate.

`rewrite-rehearse` binds the old trunk to `archive/hyprws-pre-rewrite-<12-char expected-old>`.
Rewrite-kind `unblock-apply` creates that branch under an explicit missing-ref lease, retrying only when the remote ref already equals the full expected-old SHA.
It reads the remote SHA back and retains the binding and trunk outcome in the report, and the reviewed record names the same immutable ref and SHA.
That happens before the record is posted or `hyprws` moves; a rejected trunk lease keeps the archive as failed-attempt evidence.
The rewrite never moves `hyprws-previous`.

## Model

`hyprws` is the single fork trunk.
The bot scans only through the newest stable or nightly upstream tag on the first-parent lane, never an untagged `upstream/main` head.
Its base is the newest clean tag inside that horizon; stable wins a tie at the same position.
The bot never merges upstream into the fork and never drops, squashes, reorders, or rewords a fork commit.

On each scheduled, pushed, or dispatched run the workflow:

| #   | Step                                                                                         |
| --- | -------------------------------------------------------------------------------------------- |
| 1   | Fast-forwards the `main` mirror to `upstream/main`                                           |
| 2   | Scans to the newest upstream release tag and picks the newest clean tag in that horizon      |
| 3   | Snapshots every stable upstream tag its own walk crosses, on a create-only release branch    |
| 4   | Replays and verifies the whole fork stack on the selected tag                                |
| 5   | Publishes the candidate or rewrites `hyprws`, per `HYPRWS_AUTO_REBASE`                       |
| 6   | Creates or updates stable-candidate and `rebase-blocked` issues as `Notification 🔔` signals |

A run with no newer clean release tag is a successful no-op.
The sequential rebase census to the newest tagged horizon decides the outcome when available: zero conflicting fork commits advances, one or more confirms a block at the pairwise scan's first conflicting upstream commit.
If the census fails or hits a limit, the pairwise result decides and the block records why the census was unavailable.
A confirmed block still allows an earlier clean target, and a conflict in untagged commits past the horizon is not a block.

## Regenerable files

Lockfiles, generated indexes, and version stamps carry no independently reviewable fork intent.
A sync keeps the incoming new-base version and runs the registered generator after applying the fork's source inputs.
It never 3-way merges generated entries and never treats a rerere result as a resolution.
The only path registered in this class is:

| Path             | Generator                    | Rebase rule                                                                                                 |
| ---------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml` | `vp install --lockfile-only` | At a stop, restore from `HEAD`, resolve the remaining source conflicts, run the generator, stage, continue. |

`vp install --lockfile-only` is the repository-native `pnpm install --lockfile-only`.
During a rebase `HEAD` is the selected base plus the commits already replayed, so restoring from it discards the old fork lockfile and keeps the new-base side.
Re-run the generator on the completed replay when either side changed a package manifest or the lockfile; it must be stable before apply.
No generated index or version stamp is registered yet; add one only with its deterministic generator and a row here.

`vp run fork:lockfile` proves the same regeneration on a feature branch, before the lockfile reaches a stop.
It refuses an uncommitted `pnpm-lock.yaml`, reruns the generator, compares with the drift classes the replay verification uses, and restores the committed bytes either way.
Run it on any branch that changes a package manifest: a hand-merged lockfile, or one carried forward as a replayed historical patch, fails here instead of costing a lane later.
Only `importers` drift fails it, because the generator re-resolves every open range and unrelated transitive pins move on the registry's schedule into `snapshots:`; that difference is a note, and the check is deliberately not required.

## Bot-owned refs

Never create, move, delete, or force-push these by hand:

| Ref                                                 | Meaning                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `hyprws-previous`                                   | Pre-rewrite `hyprws` head saved before an automatic trunk rewrite              |
| `hyprws-next`                                       | Verified candidate stack published while the repository is in candidate mode   |
| `release/vX.Y.Z-hyprws`                             | Create-only snapshot of the fork stack on upstream stable `vX.Y.Z`             |
| `archive/hyprws-pre-rewrite-<12-char expected-old>` | Create-only old trunk retained before a same-base historical rewrite           |
| `refs/fork/churn`                                   | Churn ledger: one orphan history holding `fork-churn.json`, one entry per walk |
| `refs/fork/rerere`                                  | Shared `.git/rr-cache`, so a carried walk replays what earlier walks resolved  |

`refs/fork/*` is append-only and never rebased, so walk data never enters the fork series and no rebase carries it.
Read one without a checkout:

```bash
git fetch origin '+refs/fork/*:refs/fork/*'
git show refs/fork/churn:fork-churn.json
```

### Churn ledger

Authoring scans read `refs/fork/churn` by default; select another named bot ref with `vp run fork:scan --ledger-ref refs/fork/<name> --no-typecheck`.
Every scan prints the declared ref, exact commit SHA, and `current`, `stale`, `offline`, or `unavailable` freshness.
An online read checks origin before and after reading immutable objects, and a moving remote never reports current.
Fetching a missing object moves no local bot ref, ordinary branch, or `FETCH_HEAD`.
`--offline` performs no fetch or remote query and reports retained local evidence explicitly.
SHA and ordinary-branch arguments are refused before Git runs; inspect a snapshot with `git show <full-sha>:fork-churn.json` instead.

The live `fork:churn report` uses that same immutable-current reader once for walks and seam records and prints its SHA and freshness in the published section.
A guidance read never overwrites unpushed local evidence, and the intentionally frozen tracked mirror keeps its local-ref behavior.

| Write       | Behaviour                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--push`    | Leases the ref origin advertises: refreshes a local ref only behind, keeps one carrying unpushed evidence, publishes against that exact advertised commit. An absent, unreachable, moving, or diverged published ledger refuses with local, remote, and expected SHAs and overwrites neither ref. |
| No `--push` | No remote query; local-ref behavior only.                                                                                                                                                                                                                                                         |

Only a verified current source can pass report policy.
A report published from stale, offline, or unavailable evidence, or with unresolved blocking seams, records `report-policy: failed` separately from publication success while the run stays green and the carried unblock walk proceeds.
The limitation stays visible in the published section, as a `::warning::` on Actions and plain stderr elsewhere.

#### Lesson reconciliation

The scan reconciles legacy walks and v2/v3 frozen seam observations against the full original per-file inventory in `docs/fork/internals/fork-churn.md`.
New observations reach the next scan carrying preferred boundary guidance where a reviewed mapping exists; unmapped lessons stay visible and unresolved.
A mapping names exact integration paths and the reviewed policy within each, not ownership of every change in the file.
Provider agent metadata guidance does not cover startup, resume, child-work results, or launcher environment behavior.
Neither absence, a boundary recommendation, nor a recorded guard proves repair.
Guidance uses `assessSeams` for observed, unverified, verified, regressed, or unobserved status from comparable receipts.
Policy references include closed historical issues, claim no live assignment, and leave outcome records untouched.

A walk and its frozen copy share one immutable observation identity.
A single new census path stays in the inventory without a hot-seam warning; distinct repeated observations can warn.
Exact file-local test harness deferrals keep their documented integration placement, and fork-owned tests get no generic sibling advice.
Order within each history is retained, and shared observation identities anchor the combined chronology.
If those constraints leave several possible orders or contradict each other, repair assessment is unavailable and the live report cannot pass policy.
Neither frozen observations nor completed walks are assumed newer for coming from one source.
Hot-seam warnings distinguish conflict-walk counts from repeated census-observation counts.

On a newer ledger schema, compatible known fields stay visible with an explicit partial-reader notice and repair assessment is unavailable until the schema is understood.
Authoring guidance keeps the original inventory; the live report publishes the limitation and returns an unavailable verdict rather than inferring a pass from missing evidence.
Known v2 and v3 envelopes are validated in full, allowed fields and v3 outcome receipts included, before the read-only lesson projection is derived.

#### Recording a seam

The v3 ledger keeps `walks`, immutable `seamRecords`, and target `outcomes` in one `fork-churn.json`.
Legacy arrays and v2 envelopes stay readable; every writer preserves their evidence, and no migration invents repairs, verification, or successful outcomes.
Freeze a named seam's full census and reviewed identity mapping before rewriting it:

```bash
vp run fork:churn record --input reviewed-seams.json --push
```

`record` validates and stores a maintainer-attested bundle and never runs the guard command a verification names.
Its one-line receipt reports added records and the resulting ref; an identical replay adds nothing.
`--push` starts from the ledger origin advertises and publishes with that exact old lease, so a checkout another writer overtook records on a normal rerun.
Malformed input leaves the ref untouched.

A bundle is `{ "version": 1, "records": [...] }`.
Each record's `id` is the SHA-256 of its canonical payload, produced by the exported `seamRecord(payload)` in `scripts/lib/fork-churn-seams.ts`.
References use record IDs and zero-based row indexes, so full `observation` records must be imported before their rows are referenced.

| Record         | Required content                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observation`  | `method`, `tag`, complete retained `files`, `evidence` from the sequential census. Legacy overlap uses `method: "legacy-pairwise-feasibility"` and `evidence: null`. |
| `mapping`      | One `from: { observation, row }`, one or more `to` rows, and maintainer `attestation: { actor, evidenceUrl }` whose HTTPS URL names the reviewed mapping record.     |
| `repair`       | A `before` row, exact `changeSha`, named `guard`, attestation.                                                                                                       |
| `verification` | `repair` ID, `after` observation ID, attestation, retained `guardProof: { sourceSha, command, exitCode, output }`. Source must match the frozen head.                |

A changed target, base, method, or partial replay stays non-comparable even when the recorded guard passed.
An attested guard failure always blocks, across those measurement boundaries included.
The importer validates retained evidence and source binding and executes no commands; the legacy bridge below is the one exception, where `record` proves the repair commit's ancestry.
`vp run fork:churn` and `vp run fork:churn --check` still render and check the mirror.

#### Legacy to sequential bridge (RSI-Software/t3code-hyprws#654)

A repair whose `before` row was last seen by a `legacy-pairwise-feasibility` walk (`evidence: null`) can reach `verified-repaired` when the `after` observation is complete under the current method and `record` proves `repair.changeSha` is an ancestor of `after.evidence.sourceSha` (`git merge-base --is-ancestor` in the current checkout), refusing otherwise.
Guard-proof binding is untouched: `guardProof.sourceSha` must still equal `after.evidence.sourceSha` with `exitCode === 0`, and attested failures always block.
Non-bridged verifications keep today's behaviour with no ancestry check.
The report marks the row `bridged: legacy`, and `compose` accepts the same case so it can emit the bundle `record` would accept.

`compose` builds that bundle from local census artifacts, so the evidence is produced rather than hand-written:

```bash
node scripts/fork-churn.ts compose --plan reviewed-seams-plan.json --out reviewed-seams.json
```

The plan is `{ "version": 1, "observations": [...], "mappings": [...], "repairs": [...], "verifications": [...] }`.
Each observation names an `alias` and a `census` path holding the stop census a sequential rehearsal wrote.
The composer freezes that census whole, refusing a count-only census, a target tag disagreeing with its own evidence, or a missing or contradicted `truncated` flag rather than recording an evidence-less observation.
Mapping, repair, and verification entries reference an alias or recorded observation ID and name a census row by `path`, with `commit` when a path repeats or an explicit `row` index.
Composing writes a file for review and never touches the ledger: `record --input` stays the only import path, guard results stay maintainer attestations, and a passing verification not comparable to its repair's before observation is refused at compose time instead of recorded and discounted later.

#### Target outcomes through distribution

`vp run fork:churn outcome` records each selected tagged upstream commit once and retains separate attempts under it.
Eligibility defaults to true even in `candidate` or `off`, on a blocked target, or when recovery needs an agent.
An exclusion needs an explicit tag-policy reason before measurement; a mode change or history rewrite cannot exclude an existing target.
`trigger` records schedule, push, or manual kickoff independently of the bot, agent, or human `executor`; optional `rewriteProvenance` belongs on the attempt.

The upstream-sync workflow writes target declarations before executing its plan, and its `always()` collectors retain clean, blocked, stopped, and failed attempts.
Report publication and report policy are separate stages, so a posted comment followed by exit 1 claims neither a failed publication nor an attempted apply.
An installed rehearsal head is not an applied trunk head; only the durable `applied` stage supplies that receipt.
Rerere publication and the workflow cache export keep their own pending and failure evidence after apply.

```bash
vp run fork:churn outcome --auto-report /path/auto-result.json --report-receipt /path/report-receipt.json --push
vp run fork:churn outcome --sync-report /path/sync-report.json --push
vp run fork:churn outcome --input reviewed-outcomes.json --push
```

Auto, rehearse, check, and apply retain a local `.outcome.json` sidecar, conflict stops and failed verification included.
List, orient, review, and refresh create no carry attempt.
Workflow identity carries the command phase and an immutable report-snapshot digest, so a stopped walk and its resumed apply retain separate attempts while re-collecting an unchanged snapshot adds nothing.
Collectors refresh the report before reading its sidecar, so an old sidecar cannot hide a later apply.
Local executing commands get a new invocation ID; readback reuses the retained snapshot evidence.
Set `FORK_OUTCOME_EXECUTOR=agent` or `human` before an operator's sync invocation, or that executor stays unknown.
`FORK_OUTCOME_EXPORT` saves an importable bundle before ledger publication, and workflow artifacts retain raw reports and outcome bundles for 90 days.

A walk row carries what the walk cost: `elapsedMs` from the walk report beside the record, `effort` from the host handoff attestation.
Both render as absent when unavailable, never as a guess.
`effort` is decoration and never a gate: only a host attestation carries it, so a delegated walk records none and no writer fills it (RSI-Software/t3code-hyprws#1090).
`node scripts/fork-churn.ts verify-cost` fails when any entry in the trailing five-walk window lacks `elapsedMs`, pending rows included; older rows stay valid outside the window.
It runs as the advisory `Verify walk cost window` step of the `rebase` job in `.github/workflows/hyprws-upstream-sync.yml`, which runs every six hours and on every `hyprws` push.

A `--push` import starts from the published `refs/fork/churn`, so an existing checkout appends to a ledger another writer advanced without a manual fetch.
When origin moves between lease and push, publication refuses with local, remote, and expected SHAs, restores the previous local ref, and a normal rerun succeeds.
Never replace the ledger with an older artifact.
Duplicate deliveries add nothing; conflicting evidence refuses with exit 1.
Seeding and every outcome write group targets by upstream commit ancestry oldest to newest while preserving declaration order inside each target, so a reviewed historical import migrates an older appended target into its original position.
Missing or incomparable target commits refuse rather than silently change streak chronology; fetch upstream tags and `main` before a manual import.

An input bundle is `{ "version": 1, "receipts": [...] }`, ordered target, attempt, then stage evidence.

| Receipt        | Names                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target         | `target: {tag, sha}`, `eligible`, `reason`. The first selected tag is immutable.                                                                                                                                         |
| Attempt        | `targetSha`, stable `attemptId`, `sourceSha`, `trigger`, `executor`, `mode`, `runUrl`.                                                                                                                                   |
| Stage          | That target and attempt, `stage`, `status`, `detail`, and the actual `sha` when successful verification, apply, or build needs it.                                                                                       |
| `target-alias` | `targetSha`, `tag`, review `reason`, imported explicitly after the original declaration when another tag resolves to the same commit. Later selection of that alias reuses the retained target and adds no streak entry. |

The release workflow's `always()` outcome job passes job results through `FORK_RELEASE_NEEDS` to `outcome --release --push`.
It resolves the nearest retained applied ancestor of the release checkout, verifies the release tag's commit, and compares every expected build asset against GitHub's published name, positive size, and SHA-256 digest.
Distribution success requires passing preflight and build receipts for the exact released SHA.
A later release SHA retains the intervening commit list and its exact-tree verification.
Failed preflight, build, or publication stays visible; rerun the release workflow to recover distribution without replaying an applied rebase.
A scheduled no-change skip at the same released SHA keeps its earlier successful distribution.
A release stopping before it identifies a checkout retains raw workflow evidence instead of inventing a target binding.

The JSON result reports retained attempts and stages plus `resume`: `sync`, `release-only`, or `complete`.
`noAgentCarry` counts consecutive eligible targets whose carry attempts were on-mode bots, automatically triggered, verified, applied, and free of blocked, unknown, pending, or failed carry stages.
Every successful apply attempt must retain selection, matching verification, apply, rerere, and cache-export receipts.
A direct clean replay marks the cache stages `not-attempted` with `notApplicableReason: "direct-clean-rebase"`; absent receipts or unexplained non-attempts cannot qualify, and incomplete stage evidence never silently preserves the streak.
`distributed` is a separate eligible-target streak, and raw blocked and rewritten targets stay in canonical upstream ancestry order.
Missing historical evidence never counts as success: a reviewed historical import names its evidence or stays unknown.
The importer validates evidence consistency; manual input is an attestation, while workflow collectors read Git and GitHub directly.

#### Seam states

The report extends the census table with explicit seam states:

| State               | Meaning                                                                                                                                                                                                                           | Report exit                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| observed            | Seen, no verified repair                                                                                                                                                                                                          | 0                                                     |
| not-observed        | Absent from the latest complete census; still unresolved                                                                                                                                                                          | 0 unless already blocking                             |
| unknown             | Partial, incompatible, or stale pre-repair observation; identity unresolved, never blocking by inheritance                                                                                                                        | 0                                                     |
| returned-unresolved | Seen again without comparable repair proof                                                                                                                                                                                        | 1                                                     |
| repair-unverified   | Named change and guard, no comparable passing evidence                                                                                                                                                                            | 1 for a failed guard, else the prior blocking verdict |
| verified-repaired   | Comparable complete replay clear and the named guard attested passing; a legacy `before` bridge carries `bridged: legacy`; a complete census on a new base that does not observe the seam carries the repair across the base move | 0                                                     |
| regressed           | A previously verified repair has comparable conflicting evidence or an attested guard failure                                                                                                                                     | 1                                                     |

An ordinary replay preserves the path, subject, and domain observation identity despite changing SHAs, and reviewed mappings preserve it through renames, moves, and splits.
Mapping chains resolve to their original identity independently of bundle order; cycles and multiple unrelated roots refuse.
A method change retains identity but cannot establish absence or return until that identity is observed with the new method, except through the legacy bridge above.
A census still bound to the frozen pre-repair source head is stale, not proof of a later regression.
Unknown methods, changed targets, and absent rows never prove repair.
A previous blocking verdict needs comparable repair verification to clear, except that a verified repair carried across a base move stays resolved (RSI-Software/t3code-hyprws#658).
The full report keeps unresolved seams visible even when absent.

#### Seeding and migration

The ledger moved off `docs/internals/fork-churn.json` onto `refs/fork/churn`.
`docs/fork/internals/fork-churn.md` is a frozen mirror; RSI-Software/t3code-hyprws#476 retires both files, and the `docs(fork-churn): row ...` commits, at a later rebase.
Seed the ref once from the file, from a clean canonical checkout of `hyprws`:

```bash
node scripts/fork-churn.ts seed --from docs/internals/fork-churn.json --push
```

Verify with `git show refs/fork/churn:fork-churn.json | head`.
Ledger mutation commands refuse a missing ref.
Authoring scans report unavailable lesson evidence explicitly and keep the original inventory; missing evidence is never presented as a current empty ledger.

A ledger seeded before census subjects became durable needs one migration, from a trusted checkout whose local object store still resolves every census SHA.
Do not rely on a fresh fetch: pruned fork-nightly refs cannot restore their commits.
Run exactly once while those objects are available:

```bash
node scripts/fork-churn.ts migrate-subjects --push
```

The all-or-nothing guard resolves every missing subject before moving the local ref, names every unresolved SHA together, and pushes with an exact expected-old lease.
A rerun after success is a no-op.
A failed leased push restores the local ref to its exact pre-migration commit, so the migration can be retried after fetching the remote winner; never replace a rejected lease with an unleased force push.
`report` stays read-only toward the ledger and refuses a subjectless ledger instead of consulting historical Git objects.

`unblock-apply` appends the walk's row and publishes the ref in the invocation that moved the trunk, so `node scripts/fork-churn.ts append ... --push` is only for a row no apply wrote.
Each report run posts a `## Churn` section on the open block issue with the conflict class mix, the agent and human split, the silent seams, and hot-seam movement since the previous report.
The section replaces itself, so the issue carries one live view.

### Release snapshots

A release snapshot never follows later trunk work.
It is the immutable branch a human cuts a stable fork tag from.

**A stable upstream tag is snapshotted and announced by whichever lane moves the fork base past it.**
The bot sees only the tags inside its own walk window, so a tag the base already passed is invisible to it forever.
An unblock apply therefore snapshots every stable tag it crosses before pushing the trunk, replaying the pre-apply stack onto each exactly as the bot would.
Each snapshot is checked for replay shape only, because `stable-prepare` runs full verification again before minting a tag.
A tag whose snapshot cannot be replayed mechanically is named in a warning and skipped; the apply that crossed it is already rehearsed, checked, and proved, so it stands.
Snapshot that tag by hand before cutting it.

The channels are cut differently.
`hyprws-release.yml` fires on every push to `hyprws`, so a leased apply cuts the nightly by itself and no operator ever cuts one.
Only the stable channel needs a `stable-list` candidate, a UAT cycle, and an explicit human go.

## Auto-rebase modes

`HYPRWS_AUTO_REBASE` takes three values; unset means `candidate`.

| Value       | Behaviour                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `off`       | Mirror and report only. No candidate or trunk ref is rewritten; blocked issues are still upserted or closed. |
| `candidate` | Publish the verified stack to `hyprws-next`; still snapshot and file issues, but do not rewrite `hyprws`.    |
| `on`        | Save the old trunk as `hyprws-previous`, then rewrite `hyprws` under an explicit expected-old lease.         |

In `on` mode a landing that triggers a rebase produces two nightlies by design: one for the landed commit, one for the bot-pushed rebased head.

The mode governs the bot only.
An unblock apply snapshots and announces the stable tags it crosses in every mode, because those tags leave the bot's window the moment the apply lands.

### Which walk modes publish, per ref

A mirror-and-report walk (`off`, or any operator walk that is not carried) publishes no bot ref: rehearsing past a conflict stop writes the pending churn row locally and leaves every remote ref alone.
Only the runner lane and the explicit human verbs publish.
The `candidate`-mode `hyprws-next` publication above is the bot's, not the walk's: an unblock never moves `hyprws-previous`, `hyprws-next`, or a release ref.

| Walk shape                                       | `hyprws` / `hyprws-next` | `refs/fork/churn` | `refs/fork/rerere` | Issue comments |
| ------------------------------------------------ | ------------------------ | ----------------- | ------------------ | -------------- |
| `unblock-auto` in `off` (mirror and report)      | no                       | no (local row)    | no                 | no             |
| `unblock-auto` in `candidate`, operator lane     | no                       | no (local row)    | no                 | no             |
| `unblock-auto --bot-carried` (runner, mode `on`) | yes                      | yes               | yes                | yes            |
| `record-decisions` (explicit human verb)         | no                       | yes               | yes                | yes            |
| `unblock-apply` (explicit human verb)            | yes                      | yes               | yes                | yes            |

### Carried unblock walk

In `on` mode a blocked candidate does not stop at the report.
The carry job restores the shared rerere cache from `refs/fork/rerere`, then runs the walk non-interactively:

```bash
node scripts/fork-sync.ts unblock-auto --bot-carried --target <newest tag beyond the block>
```

The walk's exit code decides the run:

| Exit | Meaning                         | The run                                                               |
| ---- | ------------------------------- | --------------------------------------------------------------------- |
| 0    | The walk finished the tag       | Applies under the walk's own expected-old lease and posts the record. |
| 2    | One of the two legal stops      | Posts the stop surface verbatim on the block issue for an agent.      |
| 3    | A precondition refused the walk | Reports only. Nothing is written.                                     |

Exit 2 has exactly two reasons, written into the report's `walk.stop` and the issue body:

| Stop          | Reason                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment` | The lane cannot test at all: the runner is missing, or a repair command never reached a status.                                                                                                                 |
| `conflict`    | The resolver cannot produce a row's result, its resolutions fail the lane's scoped typecheck and tests, a `fork:scan` finding names an unhealthy replay, or workflow drift needs a human's adaptation decision. |

Anything else that halts the walk is a bug in the walk, not a decision waiting for a human.

`--bot-carried` refuses unless `GITHUB_RUN_ID` is set, `HYPRWS_AUTO_REBASE` is `on`, and the bot's last recorded run is this run, so a carried walk can never take a lease another run holds.
The `hyprws-rebase` concurrency group is the outer guard, and `off` and `candidate` never carry.
The carry job injects the mode as an environment value because a job token may not read repository variables; an injected mode always wins, and the API read is the human lane's fallback.
A `--target` pins the walk to a tag that cannot move, so every step reports mirror currency without requiring it.

A carried walk mints its rehearsal lane with `git worktree` rather than Worktrunk, which a runner cannot install, and records its own leased push to `hyprws` as the reconciliation.
The rerere cache is written back to `refs/fork/rerere` after every carried walk, applied or stopped, and after every leased apply.
The report records trunk as `applied` separately from `rererePublication`.
Cache publication combines independent additions with the current remote cache under at most three explicit expected-old leases.
A different resolution at the same cache path refuses publication without replacing either resolution.
Transient `thisimage` files are excluded, and so is the regenerated lockfile, whose postimage is walk-specific.

A failed cache publication exits nonzero with the immutable snapshot and error retained in the report.
Rerun `vp run fork:sync unblock-auto --report <report>`: an in-flight report is picked up from the stage it reached, so there is no resume flag.
An applied report retries only its pending cache work; it does not rebase, repeat the trunk push, or repeat its review.
The original apply still requires the exact reviewed head, checks, stale-evidence guards, and trunk lease.

### Walk pause

Before an unblock walk, set the bot to candidate mode and leave it there until the ladder or walk series ends:

```bash
gh variable set HYPRWS_AUTO_REBASE --body candidate --repo RSI-Software/t3code-hyprws
```

No second run is needed after an apply: the leased push to `hyprws` is the workflow's trigger.
Confirm the blocked issue closes with `Resolved by hyprws <sha>` and the next block opens, or no block remains.
Restore `on` only when the ladder or walk series is complete.

### Block issue lifecycle

The bot keeps at most one open `rebase-blocked` issue and identifies it by the exact `blocking-sha` marker in its body.
A blocking SHA is filed at most once, including after its issue is manually closed.
When the first conflict changes, the bot closes the old issue by identity before creating a new one.

#### Assumptions

The workflow concurrency group is the single writer for block issues.
Dedupe also assumes the `blocking-sha` marker and `rebase-blocked` label stay intact on every open or closed block issue; stripping either can let the same SHA be filed again.

While a block remains, each run silently rewrites the issue body without changing its title.
One **Refresh log** comment records the tagged horizon in an ASCII lane: `o` is a commit, `X` the block, `N` a nightly tag, `S` a stable tag, and `Nc` the number of conflicting fork commits to that tag.
The bot edits that comment in place and appends a row only when the newest tag past the block changes.

The issue is assigned to `donjor` when created and gets a one-line comment when closed.
Those are the only human notifications for a block; body and Refresh log edits are silent.
Reporting and this lifecycle run in every mode.

The repository intentionally starts in candidate mode.
After reading a successful candidate run and preparing local lanes for recovery, enable automatic trunk rewrites:

```bash
gh variable set HYPRWS_AUTO_REBASE --body on -R RSI-Software/t3code-hyprws
```

Set the same variable to `off` or `candidate` to return; deleting it also restores the candidate default.

## One-time repository setup

### Bot token

Create a fine-grained personal access token owned by the automation actor, limited to `RSI-Software/t3code-hyprws`:

- **Contents:** read and write, for pushes
- **Workflows:** read and write, for mirrored files

Mirror, candidate, snapshot, and leased trunk pushes need Contents; mirrored upstream commits can change workflow files.
Store it as the `HYPRWS_MIRROR_TOKEN` Actions secret, which prompts for the value:

```bash
gh secret set HYPRWS_MIRROR_TOKEN -R RSI-Software/t3code-hyprws
```

The workflow uses its normal `GITHUB_TOKEN` with `issues: write` for labels and issues.
Do not widen the personal access token for issue management.

### Labels

The workflow force-creates `rebase-blocked` on every run, overwriting a drifted description with the workflow-owned text:

```bash
gh label create rebase-blocked --force --color B60205 \
  --description "The fork stack conflicts with newer upstream history" \
  -R RSI-Software/t3code-hyprws
```

The `release` label must exist before the first stable snapshot; the workflow does not create it.
This repository has it, so verify it remains available:

```bash
gh label view release -R RSI-Software/t3code-hyprws
```

### Which events run the fork matrix

`hyprws-ci.yml` produces every context the `hyprws` branch ruleset requires: `Check`, `Test`, `Test Scripts`, and the three `Test Server` shards.
It runs on a pull request opened, pushed to, or reopened, on a push to a fork trunk, rehearsal, or release branch, and on `merge_group`.

It deliberately skips `ready_for_review`.
GitHub already runs `pull_request` on a draft, so the matrix has normally passed on that exact head before the draft is marked ready; listing the event only discards a green result and pays again.

The `merge_group` trigger is what makes a merge queue possible.
A queue builds `gh-readonly-queue/hyprws/**` and waits for the required contexts on that ref.
This workflow owns all of them, so a queue without the trigger gets no report and each entry sits until it times out.
Add the trigger before requiring a queue in the ruleset, never after.

### Upstream workflows and merge settings

Keep only `hyprws-ci.yml`, `hyprws-release.yml`, and `hyprws-upstream-sync.yml` enabled.
Upstream workflows stay in the tree unchanged but disabled, because they expect upstream secrets and runners.

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

The rulesets tracked in RSI-Software/t3code-hyprws#220 are applied by hand in **Settings > Rules > Rulesets** and are all `active`.
This repository does not apply or change them unattended:

| Ruleset             | Targets and rules                                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hyprws`            | `refs/heads/hyprws`; requires a pull request with 0 approvals and the checks `Check`, `Test`, `Test Server 1`, `Test Server 2`, `Test Server 3`; repository administrators have an always-allow bypass. The bot pushes with the administrator's PAT and must force-push after a rebase, so this ruleset deliberately has no force-push rule. |
| `main`              | `refs/heads/main`; requires a pull request, same always-allow administrator bypass. Only the mirror job writes this branch.                                                                                                                                                                                                                  |
| `no trunk deletion` | `refs/heads/hyprws` and `refs/heads/main`; blocks deletion with no bypass actors, so it binds administrators and the bot.                                                                                                                                                                                                                    |
| `stable tags`       | `refs/tags/v*-hyprws.*`, excluding `refs/tags/v*-hyprws-nightly.*`; blocks deletion and updates with no bypass actors.                                                                                                                                                                                                                       |

A direct non-bypass push to `hyprws` cannot be demonstrated, because the repository has no non-admin collaborator, so the pull-request rule is documented as admin-only until one exists.

Fork CI checks the pull-request body for squash-commit ledger trailers only on a ready pull request based on `hyprws`.
It skips drafts and every other base, rebase-rehearsal branches included, because those land by a leased force-push rather than a squash merge.

### Runners

Both fork workflows run on `ubuntu-latest`.
`hyprws-release.yml` publishes a nightly on every landing on `hyprws`; its six-hour schedule is a fallback that publishes only when the head differs from the newest nightly tag.
The release job keeps the newest 7 nightlies and deletes older releases with their tags; stable releases are never pruned.
GitHub-hosted runners are free for a public repository, and pull requests from outside the org cost nothing.

The rsi-ci pool was measured on 2026-08-23 and rejected: five concurrent jobs on one 12-core container reached wall times at parity with hosted at best.
Revisit only if the pool grows or the repository goes private.
The runbook `docs/runbooks/ci-runners.md` in `RSI-Software/ops` owns the pool.

Tools the workflows need beyond the hosted image:

| Tool             | How the workflow gets it                                         |
| ---------------- | ---------------------------------------------------------------- |
| Node and `vp`    | `voidzero-dev/setup-vp@v1` installs into the workspace cache     |
| Rust and `cargo` | `dtolnay/rust-toolchain@stable` installs under the runner's home |
| ImageMagick      | Present on the hosted image; `apt-get` when missing              |

Treat a missing tool as a workflow task, not a reason to patch the build script.

### Optional T3 Connect config

The fork build leaves T3 Connect unconfigured unless these repository variables exist:

- **`T3CODE_RELAY_URL`**
- **`T3CODE_CLERK_PUBLISHABLE_KEY`**
- **`T3CODE_CLERK_JWT_TEMPLATE`**
- **`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`**

The workflow passes them through when set and leaves the feature dark when they are not.

## Reading a bot run

Open the latest `hyprws upstream sync` run and read the **Auto-rebase** job summary, not just the conclusion:

```bash
repo=RSI-Software/t3code-hyprws
gh run list --workflow hyprws-upstream-sync.yml --limit 5 -R "$repo"
run_id="$(gh run list --workflow hyprws-upstream-sync.yml --limit 1 \
  -R "$repo" --json databaseId --jq '.[0].databaseId')"
test -n "$run_id"
gh run view "$run_id" -R "$repo"
gh run view "$run_id" -R "$repo" --json url --jq .url
```

The summary emits exactly these top-level fields: mode, status, old head, base, target, rebased head, stable-candidate count.
Status is `off`, `no-op`, or `advanced`.
When a block remains, a **Blocked beyond the clean window** block adds the first conflicting upstream commit, the remaining upstream commit count, and the newest later tag.

The replay still verifies commit count and messages, the fork ledger, `vp check`, and typecheck before any push, but the summary does not itemise them.
The conflict table and affected fork commits live in the `rebase-blocked` issue body, not the run summary.
Inspect a failed run's step separately:

```bash
gh run view "$run_id" --log-failed -R "$repo"
```

In candidate mode, compare the summary's **Rebased head** with the published ref:

```bash
git fetch origin hyprws-next
git rev-parse origin/hyprws-next
```

A green run with a `rebase-blocked` issue means the bot advanced as far as it safely could and reported the next operator task.
It does not mean the whole upstream lane was clean.

## Unblocking a `rebase-blocked` issue

Run the walk from a disposable worktree off the trunk (`git worktree add --detach <dir> origin/hyprws`).
A bare worktree has no dependencies, so run `node scripts/setup-worktree.ts` inside it once first: it installs dependencies and links the canonical `.env` files, without which `vp run fork:sync` fails module resolution.

`vp run fork:sync unblock-auto [--target tag@sha] [--report <path>]` walks one eligible tag to the end in one invocation.
It selects the open walk target (or the newest offered tag), accepts a coherent orientation, resolves every conflict, repairs the lane, runs the guards, applies under the existing expected-old lease, appends the churn row, and records the apply's push as the reconciliation trigger.
That push starts the next run, which the walk does not wait for.
It asks for nothing on the way and takes no `--resume`: a report already on disk is a walk in flight, picked up from the stage it reached.
If `origin/hyprws` moves under it, the walk re-lists from the moved trunk once by itself.

### Conflict doctrine

Conflict resolution is machine-owned.
Each conflicted path goes to the shared rerere cache first; whatever rerere did not replay goes to the outcome executor, which reads the path's three index stages and applies fork doctrine in order:

| #   | Rule                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Only upstream moved at the seam, so upstream's text stands                                                                                                                             |
| 2   | Only the fork moved, so the fork feature keeps working                                                                                                                                 |
| 3   | Both moved, so keep both: a clean three-way merge stands as it is, and a conflicted one is kept only when every hunk is a pure co-insertion, on a path the lane can typecheck and test |

There is no "upstream superseded this commit" rule.
Gate 4 keeps every candidate, so taking the upstream side of a kept commit's files would keep the commit and drop the behaviour it carries.
Retiring a fork commit stays a human decision in `docs/fork/internals/fork-delta.md`.

The fork is additive, so a resolution that would drop a line upstream added at the seam is refused rather than staged.
So is a seam both sides rewrote, because a union of two rewrites says two things at once.
So are the shapes with no common ancestor on both sides (add/add, delete/modify, rename) and binary files.
A refused row is the walk's `conflict` stop.

### Lane repair

Repair runs inside the same invocation, scoped to what the replay touched.
The formatter runs over the resolved paths and every repair commit the lane carries (`Fork-Repair` commits, `fixup!`s, the walk's own repairs) before the proofs.
Then come `typecheck` per touched workspace, the focused test files beside the touched sources, and every fork-owned `*.fork.test.{ts,tsx}` tracked in the lane.
Formatted repairs are committed before the additive gate, which reads HEAD; if the commit-time formatter rewrites anything after the battery, the battery reruns once on the formatted tree, and later drift is a stop rather than a second rerun.
There is no full battery in the lane and no wait on a remote verdict, because trunk CI confirms after the apply.

A repair failing because the lane cannot run its tools is the `environment` stop.
A repair failing on its own merits is the `conflict` stop, because the staged resolutions do not hold.

Before the scan proof, the check repairs workflow drift it can review mechanically: when the fork side of a drifted workflow copy is byte-identical to the last review, it commits a refreshed reviews entry as its own fork-meta repair commit.
Drift a human must adapt stops the walk with that drift as its surface and the reviews path in the stop's allowance, so the resumed walk admits the operator's refreshed file.
A `fork:scan` failure the lane can act on is likewise the `conflict` stop with the finding as its surface, so the walk is picked up with the walk verbs (repair in the lane, rerun the check) rather than rerun from `failed:`.

Whatever a repair rewrites becomes a `fixup!` to its owning fork commit and is autosquashed from the target during the check; an ownerless path needs `--seam-owner '<path>=<full owner sha>'`, and the check discovers every `fixup!` on the lane, recorded or not.
The check reports `checked` only after proving the landed tree equals the tested tree and re-proving the replay and the fold segments.
A conflicted autosquash is aborted and the lane head restored.

### Additive proof

Before all that, the walk proves the replayed tree purely additive over the target: no target file deleted, no migration deleted or renumbered into a collision, no upstream test shrunk, no upstream-deleted line re-added.
It mechanically repairs a failure once (restore from the tag, renumber a colliding fork migration, drop re-added lines) in the same `Fork-Repair` commit.
A shape the fix refuses, such as a shrunk test or a brace-unbalanced re-add, is the `conflict` stop, because only a human can say which side to keep.

`HYPRWS_AUTO_REBASE=off` and `candidate` still suppress the trunk push, so a walk in either mode is a dry run ending at the report.

### Series rewrite review

The rest of this section is the **series rewrite**, a separate human-driven lane that rewrites the whole fork stack at once.
Only it pushes a rehearsal lane, waits on a CI verdict, and requires a second session's review verdict before apply.

The rewriting host hands the emitted report and record paths to any reviewer in another session.
The reviewer inspects the generated target, live blocking marker, every non-mechanical verdict, rehearsal evidence, pushed-lane CI on the exact installed head, every silent seam, and the live `expected_old` lease, then records one of:

```bash
vp run fork:sync unblock-review --report <report> --sign-off
vp run fork:sync unblock-review --report <report> --withhold '<reason>'
```

The command records interface, provider, model, and session for proposer and reviewer, reading each identity from `ghb attest handoff` in the active runtime.
Operators must not copy a handoff between sessions or edit those fields into the report.
The reviewer is an agent, not a human, and its provenance is not replaced by the walking agent's identity.
Sign-off is withheld for undefined fork intent, a non-equivalent retire, a user-visible behaviour change, a fork domain or tier topology change, any bypass, or evidence that cannot be verified; the automation also pauses before review when it detects those judgement surfaces.
After sign-off the host runs `vp run fork:sync unblock-apply --report <report> --record <record>`.

Apply names this control the **nightly review gate**: one recorded verdict on a `checked` report.
`unblock-apply` runs `fork:upstream-refs` on the record before the gate, so a refs-only prose fix on the same bindings keeps the verdict and never costs a second review.
It refuses a missing or withheld review, a verdict from the proposing session, any change to the reviewed bindings, moved rehearsal or CI heads, and a moved lease.
The digest binds header bindings, conflict and decision rows, silent-seam verdict rows, and verification lines; free prose never enters it.
A new proposal or movement requires a new review; never copy review fields between reports.

The unblock walk is not subject to this gate.
It carries no agent judgement verdict to review: conflict outcomes come from doctrine the code applies, verification is the lane repair it ran, and its two legal stops escalate only the rows that doctrine reserves for a human.
A stopped walk is picked up in a host agent session, and whatever that session decides by hand is a human decision recorded in the record.

### Decision records

Every walk keeps one durable record per decision (RSI-Software/t3code-hyprws#662).
Conflict rows the executor decided and rerere replays resolved land on the report's `## Decisions` section as they happen; a stop records the rows it hands to a human.
The stopped session resolves the seam in the lane, stages it, and runs `fork:sync record-decisions --report <json> --tag <tag>`, which flushes the resolution into the shared rerere ref, posts the record to the blocked issue, and writes the stopped tag's ledger row as `pending`.
The next walk resolves the same seam content (moved, retagged, or regenerated) from that record: the replay row names the walk and outcome it came from (`from <tag>`), and the applied row upgrades the pending row in place.
No maintainer decides the same seam twice; across rows a seam shows exactly one human record and one provenance-carrying replay record.

The report is an operator-owned state file, not a cryptographic signature.
The command proves the active runtime identity when it records review and binds that to the record, refs, CI head, and lease.
An operator able to rewrite the external report can fabricate its contents: the control is procedural provenance and stale-state detection, not protection from a malicious local operator.

Retirement remains human.
The walk may resolve a seam upstream now carries, but only a `retire` verdict a human wrote in the fork delta ledger drops a fork commit from the stack.

### Walk mode

#### The fold rule

A walk leases `origin/hyprws` at its `expected_old` (the incorporated frontier B) but does not freeze landings.
A landing that advances the trunk linearly folds.
At `replayed` or `checked`, `unblock-fold` replays `B..live` onto the verified candidate with fixed SHAs, proves the segment, advances the frontier, and regresses the walk to `replayed` so `unblock-check` reruns the final-tree gates on the new head.
`unblock-apply` performs the same fold-and-retry itself, bounded to three attempts, when its leased push is rejected as stale.
A `conflicts` walk holding its lane but not yet replayed defers the fold instead of voiding, rehearsing to `replayed` first.

Movement that cannot fold (a merge commit, a rewritten trunk, a moved shared base, or a moved target) voids the rehearsal and costs the full replay: `unblock-auto` re-lists from the moved trunk once by itself, and a single verb restarts at `unblock-list`, keeping the stopped lane as evidence.
A tooling fix the walk itself needs goes into the walk's lane (folded as a fixup) or runs from a branch the walk rehearses against, never landed on `hyprws` mid-walk.

#### Verb ladder

`unblock-auto` runs these transitions in one invocation.
The verbs stay callable for diagnostics, for picking a stopped walk up by hand, and for the series rewrite, which drives `unblock-check`, `unblock-review`, and `unblock-apply` directly.

| #   | Verb and contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `unblock-list` fetches and preflights, requires one current block, and writes an external report with the full blocking SHA and the selectable release tags. It accepts no target. It offers only the newest tag and names how many older ones it hid; `--all` lists every offered tag.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | `unblock-orient` consumes that report after the maintainer selects a tag, proves the target was offered and is beyond the block, and pins target, shared base, and one `expected_old`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | `unblock-rehearse` creates the bound Worktrunk lane or resumes its rebase. Every rehearsal Git call carries `core.commentChar=auto`; rebase calls also enable rerere with index autoupdate disabled. A stop names the in-flight commit by subject and short hash, lists every conflicted path, and marks each reused rerere resolution in both the stop and its conflict row, so the human reviews and stages it rather than authors it. For `pnpm-lock.yaml` it discards the textual and rerere result and applies the [regeneration rule](#regenerable-files).                                                                                                                                                      |
| 4   | `unblock-check` classifies post-replay lock drift, installs at the replay head, and runs the fork scan and ledger locally. See the contract below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | The walk fills the decision surface rather than asking: every orientation row is decided, a candidate is kept whether or not the upstream target tree already carries the work, and only a human `retire` verdict in the fork delta ledger drops a commit. A cell a human filled beats a rerun that classifies the subject differently.                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | `unblock-review` belongs to the series rewrite: it signs the `checked` report the rewrite pushed and binds the proposal record, target, blocking SHA, `expected_old`, installed and CI head, and rehearsal branch to the reviewer's session. A withheld review is durable and cannot apply.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | `unblock-apply` calls `fork:sync-gate`. For a series rewrite it also refuses a lane moved since the CI verdict, requires the review, and creates and reads back the bound old-trunk archive. It posts the record, snapshots every stable upstream tag it crosses, performs the leased apply, and announces the snapshots as candidate issues. Snapshots go up before the trunk, in the bot's order, because a create-only branch stands on its own. A rejected rewrite trunk lease leaves the archive retained as failed-attempt evidence. A failed announcement never voids the apply; it prints the snapshot branches, and those candidate issues are opened by hand because the bot will not see those tags again. |

The step 4 scan is pinned to the tag the stack sits on (the walk target, or the release tag at the fork base for a trunk rewrite), so a moved `upstream/main` cannot fail a lane for drift it did not introduce.
Record a repaired seam with `--silent-seam '<path>=<summary>:type'` or `:behaviour`.
The check proves the lane's delta with the tooling checkout's `fork-delta`, so a gate fix applies to a lane in flight without a fold.
A lane repaired by hand is committed by the check as its own `seam` repair ahead of the additive proof.
Repairs always fold into their owning fork commit, the fold segments are re-proved after the autosquash, and `--seam-owner` names the owner of a path no fork commit touched.

Post-replay lock drift is classified before the scan.
Snapshots-only drift is discarded, and importer drift is assigned to an owning fork commit and committed as a `fixup!` to it.

| Drift          | Owner rule                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshots only | No owner. The check restores the replayed lockfile.                                                                                                                                       |
| Importer       | The newest commit in the replay range introducing the moved specifier that carries `Fork-Domain` and `Fork-Tier` and is not a repair. A repair owns no domain, so it can never own drift. |

The check throws, naming the conflict, when no commit in the range owns a moved specifier, when the moved specifiers resolve to more than one owner, or when `vp i` reintroduces importer drift after the replay.
Each of those is folded into the manifest-owning fork commit by hand.
A series rewrite always throws here rather than committing, because its head is a constructed manifest result: fold the regenerated lockfile by hand and rebuild the manifest.
The check then repairs the lane in place, scoped to the replayed paths, and records every command it ran in the report's verification and `walk.repairs`.
A repair failure stops the walk with the reason it belongs to and leaves the report at the stage it reached.
Rerunning the check on a `checked` lane re-renders seams and rebinds the head; declared seams replace recorded ones by path.
Repeated checks retain the first observation for each exact path, summary, and behaviour flag, keep distinct evidence at one path separate, and normalize existing duplicates without rewriting historical ledger rows.
Refreshing invalidates prior CI and review evidence.

Only a series rewrite pushes the rehearsal lane and waits up to 45 minutes for a CI verdict, polling every 30 seconds.
A timeout or a completed red run fails that gate with bounded evidence: the run URL, its id and conclusion, the failed job names, and an ANSI-stripped tail of each failed job's log capped per line and in total.
An unreadable job list or log degrades to what the run already reported rather than replacing the verdict.
Its two sessions stay separate: the host owns the proposal, another session owns the review verdict, and a reviewer sign-off is never counted as a human choice.

Each verb consumes the JSON report the previous verb emitted and atomically advances it; no shell variable carries gate state.
The script also renders and validates the Markdown record schema, and its focused tests are that schema, so no separate prose template can drift from it.
Report and record stay outside the repository, and new rehearsals never add to `docs/fork/operations/fork-sync-records/`.
Every transition refuses stale refs, wrong lanes, incomplete rows, changed messages or counts, unowned or ambiguously owned importer drift, failed checks, and a missing, stale, same-session, or withheld review.
Never move `hyprws-previous`, `hyprws-next`, or a release ref as part of an unblock.
A successful leased push starts the bot run that reconciles the resolved blocking SHA and any later block.
The apply publishes the walk's row and outcome record on `refs/fork/churn` before reporting `applied`, and stops on `environment` naming the moved trunk when that write cannot land.

## Cut a stable release

Every stable snapshot gets one `release`-labelled `Notification 🔔` issue, whichever lane created it.
That issue is the whole entry point: a fresh session needs it and nothing else.

Exactly one candidate issue is open at a time.
Each reconcile closes a candidate whose `vX.Y.Z-hyprws.N` release tag is already on `origin` as completed, and closes a candidate an open newer one has overtaken as not planned, commenting with the newer issue.
Only the newest un-cut candidate survives, so the issue `stable-list` offers is the live one.

Invoke the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill at its **cut stable** entry point.
The stable lane is three external-report transitions; no shell variable or pasted multi-command block carries gate state.

**1. `stable-list`** runs fork preflight, reads every open stable candidate, validates each title, body, and marker, and writes an external selection report.
It accepts no issue number.
The human selects one of the reported issues; recency is not permission to infer it.
The `<!-- hyprws-stable-candidate: <name> -->` body marker is the candidate's identity; a trailing `ghb`-owned homing marker on the title (`[📥]`, `[📍]`, or `[<emoji>#N]`) is accepted and never stripped or hand-written.

**2. `stable-prepare --report <report> --issue <selected-issue>`** rereads the exact selected issue, fetches its bot-owned snapshot and tags, binds the remote commit, and creates the collision-refusing `cut/vX.Y.Z-hyprws` Worktrunk lane.
It installs with the lockfile frozen, then runs `fork:delta --check` through that lane's Vite+ binary and project environment.
The `check`, typecheck, and test verdict comes from `hyprws CI`, never the operator machine: the snapshot head is already pushed as `release/vX.Y.Z-hyprws`, so the prepare reverifies that remote head, waits up to 45 minutes for the run on that exact SHA, and records `hyprws CI <run-url>` in its verification list.
A failed job or a timeout fails the prepare with the run URL and the same bounded failed-log evidence before any UAT draft is rendered.
It derives the next stable tag through the release helper, refuses a local or remote tag collision, and revalidates snapshot, clean lane, and checked head.
It calls the existing `fork:uat` dry-run surface for the exact snapshot and writes the review draft beside the report.
The draft carries every applicable condition from the previous stable's UAT, preserving whether it was accepted or unsettled, alongside the new source material.
Tooling comes from trunk and product from the snapshot, so the canonical checkout renders that draft against the snapshot ref while every content check above runs through the lane.
A preparation failure synchronously removes the cut lane, lockfile drift included, before requiring a fresh `stable-list`; if Worktrunk cannot remove it, the refusal prints the exact forced recovery command.

**3. `stable-publish --report <report> --go <exact-candidate>`** requires the human to repeat the selected `vX.Y.Z-hyprws` candidate after UAT judgement.
It rereads the open candidate, refetches and revalidates the bound snapshot, clean lane, and absent tag, creates the annotated tag at the exact snapshot SHA, and pushes only that new tag.
It asks Worktrunk to trash the cut lane, finds and watches the exact `hyprws-release.yml` tag run, requires an `.AppImage` and `latest-linux.yml`, then closes the candidate with the tag, snapshot SHA, and workflow URL.

### UAT boundary

The preparation stop is the [`fork-uat`](../../../.agents/skills/fork-uat/SKILL.md) judgement boundary.
The agent reviews the rendered sources and carried conditions, writes observable task drafts, and removes the reviewer-only sections.
`fork:uat --prepare` compiles that review into a hashed parent tracker plus one child issue per acceptance condition and preflights every filing.
The agent shows the exact bundle to the human; only an explicit human go permits `fork:uat --create`.
The human runs the candidate, closes each passing child, and leaves follow-up or polish work open with its findings.
A `Signed off` parent comment is recommended when the candidate is accepted in principle, but neither it nor complete child closure is an automatic publication gate.

Normal UAT rendering omits `--since`; `fork:uat` selects the newest eligible stable tag for the candidate's upstream base.
`--since` is an explicit historical or human-directed override, and the rendered snapshot marks it `(overridden)` so the comparison boundary is visible before preparation.

The new parent links the previous UAT in its snapshot.
Carried children link their exact previous acceptance task and its UAT; legacy checklist rows link the previous UAT alone.
These references preserve access to earlier findings without copying comments or creating release dependencies.

### Stable sign-off stop

Present the selected issue, snapshot branch and SHA, derived tag, prior matching tags, all preparation results, the clean and ref checks, and the UAT evidence.
If the app cannot launch or basic use fails, the human withholds the explicit release go.
Ordinary open children, polish findings, and a missing parent sign-off stay non-blocking evidence.
An inexact candidate or go, stale snapshot, dirty or moved cut lane, issue change, tag collision, failed push, failed workflow, or missing asset refuses advancement.
Never increment again after a refusal without returning to `stable-list` and obtaining a fresh human go.

The issue close, immutable tag, workflow run, and GitHub release are the stable-cut record.
Do not add a human sync record for an ordinary bot snapshot.
An `upstream-watch` issue closes only after the released build carrying its fix has been installed or run and the behaviour verified.

## Recovering local lanes after a rewrite

Feature lanes must start from `hyprws`, never `hyprws-next` or a bot-owned `release/*` snapshot.
`hyprws-next` is an inspection ref: after the mode flips from candidate to on, it stays at the last candidate push and goes stale.
Release snapshots are immutable release inputs, not development bases.

`hyprws-previous` does not exist until the first on-mode run.
For that first rewrite, copy the full old head from the **Auto-rebase** run summary and use it as the old boundary:

```bash
git fetch origin hyprws
git rebase --onto origin/hyprws <old-head> <feature-branch>
```

After an on-mode run has published `hyprws-previous`, a branch based on the immediately previous trunk can use the bot-owned ref directly:

```bash
git fetch origin hyprws hyprws-previous
git rebase --onto origin/hyprws origin/hyprws-previous <feature-branch>
```

Replace `<old-head>` with the summary's full old-head SHA and `<feature-branch>` with the branch `git branch --show-current` prints in that worktree.
Inspect the range first if the lane was not based on that old boundary; do not guess an `--onto` boundary.
A lane mistakenly based on `hyprws-next` or `release/*` needs its actual merge base inspected and cannot use the generic recovery command safely.

The canonical `hyprws` worktree carries no independent commits.
Reset it to the published trunk:

```bash
git fetch origin hyprws
git reset --hard origin/hyprws
```

Never run the hard reset in a feature worktree or a checkout with uncommitted work.

## Failure handling

| Failure                                         | Response                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mirror fails**                                | Recreate `HYPRWS_MIRROR_TOKEN` when the secret is missing or expired. A rejected fast-forward means someone wrote to `main`; inspect it and never force the mirror.                                                                                                        |
| **No clean target**                             | Report-only until an upstream release tag enters the clean window. Do not target an untagged commit.                                                                                                                                                                       |
| **Feasibility said clean but replay conflicts** | An automation bug. The bot aborts the rebase and pushes nothing; do not resolve inside the workflow worktree.                                                                                                                                                              |
| **Replay verification fails**                   | The bot pushes nothing. Read the failed check and fix the fork or automation through a pull request; never weaken the commit-message or ledger comparison.                                                                                                                 |
| **The `hyprws` lease is rejected**              | Remote work appeared after the bot read the old head. Inspect the new commits and rerun from them; never replace the explicit lease with `--force` or silently refresh it.                                                                                                 |
| **A rehearsal branch already exists**           | The lane name carries the published head it replays, so a collision means that trunk head is already rehearsed against that target. Inspect the lane rather than recreating it. A trunk that has advanced produces a different name, and the stale lane stays as evidence. |
| **A stable snapshot already exists**            | It is immutable. Inspect the existing branch and issue; do not force-update it. A corrected candidate needs an explicit maintainer decision and a new record.                                                                                                              |
| **A blocked issue remains**                     | Use the skill's unblock entry point. A clean automerge is still a semantic review surface, and a fork commit is retired only by a recorded human decision.                                                                                                                 |
| **Stable release fails**                        | Leave the candidate issue open, fix the workflow or runner, and rerun the failed release. Do not move or replace a published tag.                                                                                                                                          |

## Version ordering caveat

Semver precedence is global even though the updater separates channels.
For example, `0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2`.
That does not promote a nightly to stable: the desktop update-channel resolver keeps fork nightlies on the nightly feed and stable fork releases on the stable feed.
Do not infer channel or release recency from one mixed semver sort; filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
