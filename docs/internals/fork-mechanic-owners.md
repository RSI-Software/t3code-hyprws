# Fork mechanic owners

Three surfaces implement overlapping fork mechanics: the `fork-uat` skill and script, the `fork-sync`
skill and script, and the four fork workflows (`hyprws-ci.yml`, `hyprws-release.yml`,
`hyprws-upstream-sync.yml`, `hyprws-body.yml`). This document records, for each shared mechanic, who
implements it, whether the implementations agree, and which one the others should consolidate
against.

`hyprws-ci.yml` and `hyprws-body.yml` consume branch and pull-request events but do not derive a
release version, select an upstream tag, or move a ref (`.github/workflows/hyprws-ci.yml:13`,
`.github/workflows/hyprws-body.yml:7`). They are not implementations of the versioning or push
mechanics below.

A verdict of **intentional** means the lanes legitimately answer different questions. A verdict of
**defect** means the bot lane and the human lane can reach different conclusions about the same
commit with neither citing the other.

## Divergence index

Every divergence found below, with its verdict. A defect row names the filed issue; consolidating
that mechanic closes it.

| Divergence                                                     | Mechanic                    | Verdict     | Issue                            |
| -------------------------------------------------------------- | --------------------------- | ----------- | -------------------------------- |
| Upstream prerelease grammar is not shared                      | Tag shape and validity      | defect      | `RSI-Software/t3code-hyprws#357` |
| Human unblock does not enforce first-parent eligibility        | Tag shape and validity      | defect      | `RSI-Software/t3code-hyprws#357` |
| Stable revision zero is accepted but never derived             | Tag shape and validity      | defect      | `RSI-Software/t3code-hyprws#357` |
| Bot and human replay gates run different check sets            | Preflight and check sets    | defect      | `RSI-Software/t3code-hyprws#358` |
| CI excludes the workspace that owns the fork scripts           | Preflight and check sets    | defect      | `RSI-Software/t3code-hyprws#358` |
| Human conflict capture parses trailers with Git                | `Fork-*` trailer parsing    | defect      | `RSI-Software/t3code-hyprws#359` |
| Unknown `Fork-Domain` and `Fork-Upstreamable` values pass      | `Fork-*` trailer parsing    | defect      | `RSI-Software/t3code-hyprws#359` |
| Release preflight discards its tested previous-tag result      | Release version derivation  | defect      | `RSI-Software/t3code-hyprws#360` |
| The stable `N + 1` calculation lives only in runbook shell     | Release version derivation  | defect      | `RSI-Software/t3code-hyprws#360` |
| A closed blocked issue suppresses refiling for a live block    | Fork issue reads and writes | defect      | `RSI-Software/t3code-hyprws#361` |
| An absent ledger reads as no retirement decisions              | Delta ledger reads          | defect      | `RSI-Software/t3code-hyprws#361` |
| UAT and nightly use different base labels                      | Release version derivation  | intentional | —                                |
| UAT and Body answer non-source questions                       | Preflight and check sets    | intentional | —                                |
| UAT, stable-candidate, and blocked issues have distinct shapes | Fork issue reads and writes | intentional | —                                |
| Human apply defers closure to observed bot state               | Fork issue reads and writes | intentional | —                                |
| Scanners parse the full body above `Co-authored-by`            | `Fork-*` trailer parsing    | intentional | —                                |
| UAT refuses an empty delta stack                               | Delta ledger reads          | intentional | —                                |
| Force and create-only rules differ per ref                     | Lease and push policy       | intentional | —                                |

The delta revision has one implementation and no divergence to record. The human stable-cut block
never calls it while the skill claims identical preflight coverage: an ownership and wording gap,
tracked with the release-version defect above.

## Release version derivation

### Implementations

| Surface                | Current implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Executable evidence |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `fork-uat`             | The skill names a revision-free acceptance target, `vX.Y.Z-hyprws`, from the ref's upstream base (`.agents/skills/fork-uat/SKILL.md:14`, `.agents/skills/fork-uat/SKILL.md:17`). The script finds the merge base with `upstream/main`, chooses a release-looking tag at that commit, drops any prerelease suffix, and derives the same revision-free target (`scripts/fork-uat.ts:503`, `scripts/fork-uat.ts:511`, `scripts/fork-uat.ts:211`). It separately chooses the previous stable fork tag numerically at or below the base version (`scripts/fork-uat.ts:109`, `scripts/fork-uat.ts:638`). Tests cover stable and nightly base derivation and previous-stable ordering (`scripts/fork-uat.test.ts:37`, `scripts/fork-uat.test.ts:54`).                                                                                                                                                            |
| `fork-sync` stable cut | The skill delegates the actual calculation to the runbook and says that gate derives the next release number (`.agents/skills/fork-sync/SKILL.md:92`). The runbook strips `v` and `-hyprws` from the candidate name, scans matching local tags for the greatest numeric revision, and adds one (`docs/operations/fork-sync.md:352`, `docs/operations/fork-sync.md:378`, `docs/operations/fork-sync.md:381`). No function in `scripts/fork-sync.ts` implements stable release numbering, and there is no focused test for this shell calculation.                                                                                                                                                                                                                                                                                                                                                          |
| Release workflow       | Preflight calls `scripts/fork-release-version.ts` directly for both channels (`.github/workflows/hyprws-release.yml:166`, `.github/workflows/hyprws-release.yml:177`, `.github/workflows/hyprws-release.yml:184`). Stable metadata accepts an already-numbered `vX.Y.Z-hyprws.N` tag and removes `v`; it does not derive `N` (`scripts/fork-release-version.ts:182`). Nightly metadata reads the next desktop patch version and appends `-hyprws-nightly.YYYYMMDD.<run>` (`scripts/fork-release-version.ts:164`, `scripts/fork-release-version.ts:292`). The helper also computes the previous release independently per channel (`scripts/fork-release-version.ts:118`, `scripts/fork-release-version.ts:301`), with direct tests for both forms and channel ordering (`scripts/fork-release-version.test.ts:15`, `scripts/fork-release-version.test.ts:29`, `scripts/fork-release-version.test.ts:53`). |
| Delta revision         | Only release preflight calls `scripts/fork-release-delta-rev.ts`, again by direct `node` path (`.github/workflows/hyprws-release.yml:219`). It takes the merge base of the requested base and head, rejects a range containing a merge, computes stable patch IDs in stack order, and SHA-256 hashes their newline-terminated sequence (`scripts/fork-release-delta-rev.ts:58`, `scripts/fork-release-delta-rev.ts:83`, `scripts/fork-release-delta-rev.ts:93`). Tests fix the hash serialization and Git range calls (`scripts/fork-release-delta-rev.test.ts:13`, `scripts/fork-release-delta-rev.test.ts:24`).                                                                                                                                                                                                                                                                                         |

Neither release helper has a `vp run` alias: the root aliases cover `fork:uat`, `fork:sync`,
`fork:auto-rebase`, and `fork:sync-gate`, but not either release helper (`package.json:48`,
`package.json:52`). `hyprws-upstream-sync.yml`, `hyprws-ci.yml`, and `hyprws-body.yml` do not call or
reimplement either helper.

### Do they agree?

They agree on the normal stable path. An upstream candidate `v1.2.3-hyprws` with existing stable
tags through `v1.2.3-hyprws.4` becomes `v1.2.3-hyprws.5` in the human cut. UAT labels the same
candidate `v1.2.3-hyprws`, and release preflight turns the pushed tag into version
`1.2.3-hyprws.5`.

Two differences and one ownership gap remain:

1. **Defect — release preflight discards its tested previous-tag result.**
   `fork-release-version.ts` emits the greatest earlier tag in the active channel
   (`scripts/fork-release-version.ts:303`), but the workflow ignores that output and reimplements
   `previous_tag` as the greatest nightly tag for every channel
   (`.github/workflows/hyprws-release.yml:190`). For current tag `v1.2.3-hyprws.3` and available
   tags `v1.2.3-hyprws.2` and `v1.2.4-hyprws-nightly.20260901.8`, the tested resolver returns
   `v1.2.3-hyprws.2`; the workflow supplies the nightly tag to release-note generation
   (`.github/workflows/hyprws-release.yml:343`). Stable notes therefore compare across channels.

2. **Intentional — UAT and nightly use different base labels.**
   UAT labels acceptance by the upstream base core; nightly labels artifacts by the next patch in
   desktop package metadata. For upstream base `v1.4.0` and desktop package version `1.3.9`, UAT
   derives `v1.4.0-hyprws` while the nightly helper derives
   `1.3.10-hyprws-nightly.<date>.<run>`. These are legitimately different lanes: stable identity is
   tied to an upstream snapshot, while the nightly updater needs the next desktop package version.

The delta revision has no second implementation to disagree with. The human check block does not
call it (`docs/operations/fork-sync.md:370`), despite the skill describing those commands as the same
preflight checks as the workflow (`.agents/skills/fork-sync/SKILL.md:95`). That is an ownership and
wording gap, not a demonstrated verdict divergence: UAT already rejects merge-containing candidate
history (`scripts/fork-uat.ts:649`), which is the delta helper's explicit structural refusal. No
other concrete candidate that passes the human gates and fails delta derivation is established here.

### Verdict

**Defect**, with one intentional channel distinction and one non-demonstrated ownership gap. The
stable previous-tag comparison can produce incorrect release notes.

### Consolidation target

No single existing file should combine release identity with the delta fingerprint. The existing
pair is the destination:

- `scripts/fork-release-version.ts` owns channel metadata and previous-tag selection. It should also
  absorb the stable `N + 1` calculation now implemented as runbook shell; the workflow must consume
  its emitted `previous_tag` instead of recomputing one.
- `scripts/fork-release-delta-rev.ts` owns the delta revision and merge rejection. The stable-cut
  prose must stop claiming identical preflight coverage unless the human verification also calls it.

These are operator entry points with focused tests, so `scripts/lib/` is not the primary destination
for this mechanic. Pure parsing may be extracted later only to support the two entry points; moving
the commands themselves into `scripts/lib/` would hide rather than declare ownership.

## Tag shape and validity

### Implementations

| Surface                | Current implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Executable evidence |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `fork-uat`             | Fork stable tags use `vX.Y.Z-hyprws.N`, while upstream tags accept `vX.Y.Z` followed by any prerelease suffix (`scripts/fork-uat.ts:15`, `scripts/fork-uat.ts:16`). An upstream-base tag is eligible only when it points exactly at the ref/upstream merge base; stable-looking tags are preferred over names containing `-nightly.` at the same numeric core (`scripts/fork-uat.ts:507`, `scripts/fork-uat.ts:514`). Previous fork stable eligibility is numeric version at or below that upstream core, with a carried stable tag excluded from its own comparison (`scripts/fork-uat.ts:114`, `scripts/fork-uat.ts:122`). Tests cover stable/nightly cores and carried stable exclusion, but not malformed upstream prereleases (`scripts/fork-uat.test.ts:43`, `scripts/fork-uat.test.ts:54`).                                                              |
| `fork-sync` unblock    | Stable upstream tags are exactly `vX.Y.Z`; nightly tags are exactly `vX.Y.Z-nightly.YYYYMMDD.N` at the regex level (`scripts/fork-sync.ts:11`, `scripts/fork-sync.ts:12`). A tag is offered when it contains the blocking commit and its tagged commit is an ancestor of `upstream/main` (`scripts/fork-sync.ts:395`, `scripts/fork-sync.ts:405`). Orientation then accepts only a tag pinned in the prior report and refuses a moved tag (`scripts/fork-sync.ts:482`, `scripts/fork-sync.ts:493`). `fork-sync-gate` duplicates the grammar, defaults to stable-only, and requires an explicit nightly opt-in (`scripts/fork-sync-gate.ts:16`, `scripts/fork-sync-gate.ts:73`). Its tests cover malformed nightly rejection; candidate listing tests only one stable tag (`scripts/fork-sync-gate.test.ts:50`, `scripts/fork-sync.test.ts:108`).                |
| Upstream-sync workflow | The workflow delegates selection to `fork:auto-rebase` (`.github/workflows/hyprws-upstream-sync.yml:148`). That script accepts exact stable tags but any suffix after `vX.Y.Z-nightly.`, restricts tags to commits on the upstream first-parent lane, selects the newest clean position, and prefers stable over nightly at one position (`scripts/fork-auto-rebase.ts:32`, `scripts/fork-auto-rebase.ts:216`, `scripts/fork-auto-rebase.ts:251`, `scripts/fork-auto-rebase.ts:258`). Stable tags not already represented by a snapshot or fork stable tag become `release/vX.Y.Z-hyprws` candidates (`scripts/fork-auto-rebase.ts:223`, `scripts/fork-auto-rebase.ts:752`). Tests cover stable tie preference and existing-release exclusion, but not malformed nightly names (`scripts/fork-auto-rebase.test.ts:76`, `scripts/fork-auto-rebase.test.ts:714`). |
| Release workflow       | Stable publication is triggered broadly by `v*-hyprws.*` except nightly names, then preflight and `fork-release-version.ts` require `vX.Y.Z-hyprws.N` (`.github/workflows/hyprws-release.yml:14`, `.github/workflows/hyprws-release.yml:135`, `scripts/fork-release-version.ts:79`). Nightly tags are generated as `vX.Y.Z-hyprws-nightly.YYYYMMDD.N` (`scripts/fork-release-version.ts:92`, `scripts/fork-release-version.ts:171`). Upstream-base reporting is separate shell: prefer any tag at the merge base that does not contain `-nightly.`, otherwise take the first tag, otherwise use `git describe` (`.github/workflows/hyprws-release.yml:204`).                                                                                                                                                                                                    |

### Do they agree?

They agree for the documented shapes `vX.Y.Z`, `vX.Y.Z-nightly.YYYYMMDD.N`,
`vX.Y.Z-hyprws.N`, and `vX.Y.Z-hyprws-nightly.YYYYMMDD.N`. They disagree on three concrete
boundaries:

1. **Defect — upstream prerelease grammar is not shared.** With tag `v1.2.3-rc.1` pointing at the
   merge base, UAT accepts it and derives `v1.2.3-hyprws`; both sync implementations reject it. With
   first-parent tag `v1.2.3-nightly.foo`, auto-rebase accepts it, while `fork-sync` listing and gate
   reject it. A human and the bot can therefore disagree both on whether a commit has a supported
   upstream base and whether it is a selectable target.

2. **Defect — human unblock does not enforce first-parent eligibility.** Put
   `v1.2.3-nightly.20260901.7` on a side-branch commit after the blocking commit and merge that side
   branch into `upstream/main`. `fork-sync` offers it because both ancestry tests pass
   (`scripts/fork-sync.ts:405`), while auto-rebase omits it because the tag SHA has no first-parent
   position (`scripts/fork-auto-rebase.ts:242`). The declared bot model is first-parent-only
   (`docs/operations/fork-sync.md:16`), so the human lane can select a target outside the repository's
   release lane.

3. **Defect — revision zero is accepted but never derived.** The human stable calculation starts at
   one and increments (`docs/operations/fork-sync.md:381`), but UAT and release preflight both accept
   `v1.2.3-hyprws.0` because their stable parsers allow every digit sequence
   (`scripts/fork-uat.ts:15`, `scripts/fork-release-version.ts:80`). Pushing that concrete tag starts
   the stable workflow and publishes it even though the documented revision sequence starts at one.
   No focused test rejects zero.

All upstream nightly parsers also accept an impossible eight-digit date such as
`v1.2.3-nightly.99999999.1`. This is a shared validation gap rather than a cross-surface divergence;
none of the tag tests exercises calendar validity.

### Verdict

**Defect.** The broad grammar and ancestry-only human eligibility can make bot and human lanes choose
different targets, and stable revision zero bypasses the only derivation rule.

### Consolidation target

No current implementation owns both shape and eligibility. The destination should be shared pure
policy under the existing `scripts/lib/` boundary: take the exact stable/nightly grammar from
`scripts/fork-sync-gate.ts:16` and the first-parent positioning and stable tie-break from
`scripts/fork-auto-rebase.ts:251`. `fork-uat`, `fork-sync`, `fork:auto-rebase`, release metadata, and
release upstream-base reporting must consume that policy. This mechanic is a good `scripts/lib/`
candidate because all callers need identical parsing and classification, while their surrounding
Git operations remain lane-specific.

## Preflight and check sets

### Implementations

- The UAT skill treats an empty ledger or row set, a merge commit, a missing trailer, a dirty ref, a command failure, or a publishing refusal as a stop (`.agents/skills/fork-uat/SKILL.md:35`). The script proves that the current and previous refs have no merge commits, reads both through `fork:delta --json`, requires each ledger to be non-empty and finding-free, and runs `ghb issue create --dry-run` (`scripts/fork-uat.ts:457`, `scripts/fork-uat.ts:477`, `scripts/fork-uat.ts:649`, `scripts/fork-uat.ts:685`). These are UAT-input checks; they do not compile or test the ref.
- The human sync skill declares scan, ledger, derived typechecks, and adjacent tests as its replay gate (`.agents/skills/fork-sync/SKILL.md:54`). `unblock-list`, `unblock-orient`, and the initial rehearsal each run the six-condition sync preflight (`scripts/fork-sync.ts:423`, `scripts/fork-sync.ts:486`, `scripts/fork-sync.ts:573`); the preflight checks both remotes, rerere, a freshly fetched `origin/hyprws`, the `origin/main` mirror, and installed dependencies (`scripts/fork-preflight.ts:209`). The replay gate installs the replayed tree, runs `fork:scan`, `fork:delta --check`, typechecks packages selected from overlap/conflict paths, and runs adjacent tests selected from those paths (`scripts/fork-sync.ts:792`, `scripts/fork-sync.ts:837`). `fork:scan` additionally invokes the seven fork-touched product-package typechecks but fails only errors in fork-owned files (`scripts/fork-scan.ts:385`, `scripts/fork-scan.ts:429`).
- The automatic sync workflow delegates its verdict to `fork:auto-rebase` (`.github/workflows/hyprws-upstream-sync.yml:148`). That verifier preserves commit count and byte-identical messages, installs or shares dependencies, then runs `fork:delta --check`, `vp check`, and the repo-wide typecheck; it runs neither `fork:scan` nor tests (`scripts/fork-auto-rebase.ts:359`, `scripts/fork-auto-rebase.ts:389`).
- Fork CI checks the pull-request head rather than GitHub's synthetic merge commit. Its `Check` job runs the delta guard, an advisory scan without typechecking, Electron setup, `vp check`, repo typecheck, and the desktop build (`.github/workflows/hyprws-ci.yml:61`, `.github/workflows/hyprws-ci.yml:77`, `.github/workflows/hyprws-ci.yml:83`). Its test jobs cover every workspace except `t3` and `@t3tools/monorepo`, then shard `t3`; the scripts workspace therefore has no CI test job (`.github/workflows/hyprws-ci.yml:104`, `.github/workflows/hyprws-ci.yml:126`, `.github/workflows/hyprws-ci.yml:132`).
- The body workflow is a second PR verdict. It reads the live body, checks upstream citations, and checks the prospective squash message only when the PR is non-draft and targets `hyprws` (`.github/workflows/hyprws-body.yml:58`, `.github/workflows/hyprws-body.yml:71`). It deliberately does not replace source CI (`.github/workflows/hyprws-body.yml:3`).
- Release preflight runs the delta guard, `vp check`, repo-wide typecheck, and every workspace test before building (`.github/workflows/hyprws-release.yml:198`, `.github/workflows/hyprws-release.yml:223`). The stable skill explicitly requires this same set through `vp run test` (`.agents/skills/fork-sync/SKILL.md:90`).

### Do they agree?

They agree that every publishable fork commit must pass `fork:delta --check`. The body workflow is intentionally additive: the concrete input is a source head whose commits are correctly tagged but whose PR body ends in prose rather than a trailer block. Source CI may pass, while Body fails because that prose would become the squash commit message. UAT is also intentionally different: the concrete input `upstream/main` has an empty but otherwise valid delta, so `fork:delta --check` reports zero tagged commits while UAT refuses an empty comparison (`scripts/fork-uat.ts:469`). Neither surface claims to be a code-quality verdict.

The bot and human replay gates disagree in both directions on the same replayed commit:

- A replay that leaves a formatter violation in `docs/internals/fork-delta.md` but has valid trailers, complete scan tables, no type error, and no adjacent test passes the human command set and fails the bot's `vp check`.
- A replay overlap in `scripts/fork-uat.ts` that preserves formatting and types but breaks an assertion in `scripts/fork-uat.test.ts` fails the human adjacent-test selection and passes the bot verifier, which runs no test. The test selection and its ordering after install are executable behavior (`scripts/fork-sync.test.ts:389`).

Fork CI and release also disagree on a concrete scripts-only test regression: `scripts/fork-uat.test.ts` can fail while all CI jobs pass because CI excludes `@t3tools/monorepo`; release later fails because it runs every workspace test.

### Verdict

- The UAT and body differences are **intentional**. They answer acceptance-input and future-squash-message questions that source checks cannot answer.
- The bot/human replay difference is a **defect**. “Verified replay” has two meanings, so candidate or trunk publication can accept a commit that human unblock rejects, and human unblock can accept one that bot verification rejects.
- The CI/release scripts-test difference is a **defect**. A fork-mechanic regression can clear the required PR checks and fail only when release runs.

### Consolidation target

The release preflight at `.github/workflows/hyprws-release.yml:198` is the best existing complete passing set: ledger, check, typecheck, and all tests. Automatic sync and CI must reach that set. Human sync still needs its existing target-aware `fork:scan` before the common set; its scan is rebase evidence, not a replacement for `vp check` or tests. UAT and Body remain separate because neither is a source-verification lane. No check-set helper currently exists in `scripts/lib/`; command orchestration belongs in the calling workflow or operator script rather than a library.

## Fork issue reads and writes

### Implementations

- UAT reads PR bodies only to give product commits context (`scripts/fork-uat.ts:425`). It creates one human-owned issue through `ghb`, with a reviewed body file, exact `UAT vX.Y.Z-hyprws` title, Task type, Medium priority, Human filer, `release` label, no project, and an explicit relationship or `--no-relationship` (`scripts/fork-uat.ts:572`). Creation re-resolves the reviewed ref and rejects a dirty or moved ref (`scripts/fork-uat.ts:599`). The skill leaves row state and `Signed off` or `Blocked: <reason>` comments to the human (`.agents/skills/fork-uat/SKILL.md:38`).
- Human unblock lists open issues carrying `rebase-blocked`, requires exactly one, reads its number, title, and body, displays comments, and binds the full `blocking-sha` HTML marker into the external report (`scripts/fork-sync.ts:360`, `scripts/fork-sync.ts:381`, `scripts/fork-sync.ts:416`). Orientation repeats the read and rejects a changed number or marker (`scripts/fork-sync.ts:473`). Apply posts the reviewed record and a resolution comment, but does not close or relabel the issue (`scripts/fork-sync.ts:894`, `scripts/fork-sync.ts:927`, `scripts/fork-sync.ts:949`).
- Automatic sync constructs the blocked body and marker in `scripts/lib/fork-rebase-issues.ts:115`. The workflow passes that payload to the notifier (`.github/workflows/hyprws-upstream-sync.yml:176`). The notifier lists all open and closed labelled issues, identities them by full blocking SHA, closes surplus open identities, refreshes the matching body's census and one refresh-log comment, or creates one assigned High-priority Bug with `rebase-blocked` and `ci` labels (`scripts/fork-rebase-notify.ts:198`, `scripts/fork-rebase-notify.ts:409`, `scripts/fork-rebase-notify.ts:472`). A later clear result comments and closes the open identity (`scripts/fork-rebase-notify.ts:190`). These transitions have focused coverage (`scripts/fork-rebase-notify.test.ts:149`, `scripts/fork-rebase-notify.test.ts:273`, `scripts/fork-rebase-notify.test.ts:310`).
- Automatic sync also deduplicates stable-candidate issues across all states by an exact body marker and creates a `release`-labelled issue from the generated body (`.github/workflows/hyprws-upstream-sync.yml:184`). The stable skill reads open `release` issues, then requires the selected issue's exact title, snapshot body, and remote branch; successful publication closes it, while a failed release leaves it open (`.agents/skills/fork-sync/SKILL.md:75`, `.agents/skills/fork-sync/SKILL.md:109`).
- CI reads no issue. Body reads a PR body, not an issue (`.github/workflows/hyprws-body.yml:58`). Release publishes a GitHub Release and does not mutate its candidate issue (`.github/workflows/hyprws-release.yml:318`).

### Do they agree?

The issue classes intentionally differ. The concrete input of one open UAT issue and one open stable candidate gives two `release`-labelled results, but the stable lane accepts only the exact `Stable candidate vX.Y.Z-hyprws` title and matching snapshot marker. UAT uses `ghb` metadata and relationships; the bot-owned block and stable-candidate writers use their purpose-specific labels and bodies.

The `rebase-blocked` state machines do not agree. Given a closed labelled issue whose body contains blocking SHA `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, followed by a new bot payload blocked on that same SHA, the notifier refuses to refile because any open or closed issue with that marker suppresses creation (`scripts/fork-rebase-notify.ts:225`). That behavior is explicitly tested (`scripts/fork-rebase-notify.test.ts:323`). Human `unblock-list` then finds zero open issues and refuses, even though automatic sync still reports the block.

Human apply's lack of an immediate close is intentional: the successful push triggers automatic sync, and notifier reconciliation owns the state transition after observing the published trunk. The human lane owns immutable evidence comments, not final bot state.

### Verdict

- Purpose-specific UAT, stable-candidate, and blocked-issue shapes are **intentional**.
- Closed-identity suppression in the blocked lane is a **defect**. Manual closure of an unresolved blocker permanently removes the human unblock entry point for that SHA.
- Deferred closure after human apply is **intentional** because the bot closes from observed published state.

### Consolidation target

`scripts/fork-rebase-notify.ts:198` is the best existing owner of `rebase-blocked` lifecycle: it has identity, deduplication, body refresh, comments, metadata, and state transitions with focused tests. It must recreate or reopen a matching closed identity while the block is current. `scripts/fork-sync.ts` should remain a read-and-evidence client but consume the same marker/identity helpers from `scripts/lib/fork-rebase-issues.ts` instead of keeping its own marker regex. UAT remains owned by `ghb`; stable candidates remain owned by the upstream-sync workflow. `scripts/lib/` is appropriate only for pure issue shapes and identity parsing, not GitHub mutation.

## `Fork-*` trailer parsing

### Implementations

- `fork:delta` reads the full `%b` body and scans lines case-insensitively for the first `Fork-Domain`, `Fork-Tier`, and `Fork-Upstreamable` value (`scripts/fork-delta.ts:96`, `scripts/fork-delta.ts:108`, `scripts/fork-delta.ts:118`). It deliberately sees fork trailers above a trailing `Co-authored-by` paragraph; that case has a focused test (`scripts/fork-delta.test.ts:87`). The squash-body path first restricts input to the last all-trailer paragraph, then uses the same parser (`scripts/fork-delta.ts:144`, `scripts/fork-delta.ts:165`). Tier is validated against `core`, `qol`, and `bugfix`; bugfix requires only the presence of `Fork-Upstreamable` (`scripts/fork-delta.ts:185`).
- Rebase feasibility and the orientation/report path carry a second full-body line scanner. It shares only value normalization, parses Domain and Tier, and does not parse Upstreamable (`scripts/lib/fork-rebase-feasibility.ts:167`, `scripts/lib/fork-rebase-feasibility.ts:178`).
- Human conflict capture asks Git's `%(trailers:key=Fork-Domain,valueonly)` parser for Domain at `REBASE_HEAD`; it parses neither Tier nor Upstreamable (`scripts/fork-sync.ts:527`).
- UAT does not parse commit messages itself. It consumes Domain and Tier from `fork:delta --json` (`scripts/fork-uat.ts:19`, `scripts/fork-uat.ts:457`). CI, Body, Release, and automatic sync likewise invoke `fork:delta` rather than adding workflow parsers (`.github/workflows/hyprws-ci.yml:61`, `.github/workflows/hyprws-body.yml:71`, `.github/workflows/hyprws-release.yml:198`, `scripts/fork-auto-rebase.ts:389`).

### Do they agree?

The two full-body scanners agree because they duplicate the same algorithm and `normalizeTrailerValue` (`scripts/lib/fork-trailers.ts:1`). The Git parser does not. For this concrete body:

```text
Fork-Domain: fork-meta
Fork-Tier: bugfix
Fork-Upstreamable: no

Co-authored-by: donjor <donjor@example.com>
```

`fork:delta` and feasibility return `fork-meta` and `bugfix`; Git recognizes only the final co-author trailer paragraph, so human conflict capture records Domain as `?`. A GitHub UI squash produces exactly this shape, and the delta test establishes that it is supported input (`scripts/fork-delta.test.ts:87`). Conflict evidence can therefore lose its domain while every ledger check passes.

The canonical validator also agrees with all callers on an invalid contract. The concrete trailer block `Fork-Domain: typoo`, `Fork-Tier: bugfix`, `Fork-Upstreamable: maybe` passes: Domain is checked only for presence and Upstreamable only for presence, although the fork contract requires an indexed domain and `yes` or `no` (`docs/internals/fork-delta.md:111`). Feasibility ignores Upstreamable entirely. This is not a parser disagreement; it is a shared validation gap.

### Verdict

- Full-body parsing above `Co-authored-by` is **intentional** and necessary for landed GitHub squash commits.
- Git-parser use in human conflict capture is a **defect** because it drops supported metadata.
- Acceptance of unknown Domain and Upstreamable values is a **defect** because malformed commits pass every automated ledger gate.

### Consolidation target

`parseForkLog` in `scripts/fork-delta.ts:118` is the best existing behavior and the only implementation with direct tests for all three scoped trailers. Its pure trailer extraction and validation belong in the existing `scripts/lib/fork-trailers.ts`, replacing the feasibility scanner and Git's conflict-capture parser. The squash-body paragraph selection remains a caller-specific boundary. No workflow should parse trailers.

## Delta ledger reads

### Implementations

- `fork:delta` is the canonical commit-ledger reader. It reads `docs/internals/fork-delta.md` as required input through `parseForkRetirementLedger`, also reads the wire baseline, inventories `upstream/main..HEAD`, and applies retirement decisions before reporting findings (`scripts/fork-delta.ts:488`, `scripts/fork-delta.ts:493`, `scripts/fork-delta.ts:496`). The strict Markdown table parser is already shared and rejects missing sections, unexpected headers, invalid dividers, empty subjects, and duplicate subjects (`scripts/lib/fork-retirement-ledger.ts:54`, `scripts/lib/fork-retirement-ledger.ts:84`, `scripts/lib/fork-retirement-ledger.ts:99`).
- UAT shells out to canonical `fork:delta --json` for current and previous snapshots, then reimplements two consumer checks: non-empty commits and zero findings (`scripts/fork-uat.ts:457`). It does not read retirement Markdown directly.
- Human orientation reads `docs/internals/fork-delta.md` directly and uses the shared parser, but substitutes an empty retirement ledger if the file is absent (`scripts/fork-orient.ts:366`). `fork-sync` reaches that reader through `scripts/fork-orient.ts` (`scripts/fork-sync.ts:500`).
- The standalone rebase report independently opens the same path and uses the same parser, with no absent-file fallback (`scripts/fork-rebase-report.ts:983`). Feasibility then reads the fork stack separately for report classification (`scripts/fork-rebase-report.ts:469`).
- CI, Body, Release, and automatic sync delegate commit-ledger reads to `fork:delta`; the workflow files do not parse its JSON or Markdown. Body's squash-body mode intentionally does not need retirement history because it validates one prospective commit (`scripts/fork-delta.ts:468`).

### Do they agree?

For a present, well-formed ledger, the direct readers agree because they use `parseForkRetirementLedger`. UAT's additional empty-stack refusal is intentional acceptance scope, not a different retirement decision.

For the concrete input where `docs/internals/fork-delta.md` is absent, orientation silently uses no retirement decisions and can present every previously kept or retired subject as undecided; `fork:delta` and the standalone report fail the file read. Gate 1 can therefore present a different retirement surface from the canonical ledger command on the same tree. There is no focused test for the orientation fallback, while the parser and report fixtures exercise required ledger input (`scripts/fork-delta.test.ts:123`, `scripts/fork-rebase-report.test.ts:374`).

### Verdict

- UAT's non-empty requirement is **intentional** because an acceptance issue requires at least one product delta.
- Orientation's absent-ledger fallback is a **defect**. Missing fork retirement history must stop a sync rather than turn recorded decisions into `none`.
- Repeated file opening is duplication, but the shared parser keeps present-file semantics aligned; it is a consolidation risk rather than a demonstrated behavior defect.

### Consolidation target

The required read in `scripts/fork-delta.ts:488` is the best existing policy, and `parseForkRetirementLedger` in `scripts/lib/fork-retirement-ledger.ts:99` is the existing parsing owner. Orientation must adopt the required-file policy. The existing library is the right destination for one required ledger-file reader so `fork:delta`, orientation, and rebase report cannot choose different absence semantics. UAT should continue consuming canonical JSON rather than reimplementing retirement decisions.

## Lease and push policy

### Implementations

| Surface                  | Current implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Executable evidence |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `fork-uat`               | The skill expressly forbids moving, creating, or pushing a ref (`.agents/skills/fork-uat/SKILL.md:8`). The script has no ref mutation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fork-sync` unblock      | Orientation records `origin/hyprws` as `expectedOld` (`scripts/fork-sync.ts:495`). Apply runs `fork:sync-gate`, whose preflight freshly fetches the live trunk and compares it with the signed record (`scripts/fork-sync-gate.ts:173`, `scripts/fork-sync-gate.ts:185`, `scripts/fork-sync-gate.ts:220`). The only push is `HEAD:refs/heads/hyprws` with `--force-with-lease=refs/heads/hyprws:<expectedOld>`; rejection voids the report (`scripts/fork-sync.ts:933`, `.agents/skills/fork-sync/SKILL.md:70`). The test asserts the explicit lease (`scripts/fork-sync.test.ts:318`).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fork-sync` stable cut   | The source must be the immutable bot-owned `release/vX.Y.Z-hyprws` snapshot; the human must not move that branch or replace a stable tag (`.agents/skills/fork-sync/SKILL.md:75`). The runbook re-fetches the snapshot, checks the prospective remote tag is absent, and pushes only the new annotated tag without force (`docs/operations/fork-sync.md:384`, `docs/operations/fork-sync.md:388`, `docs/operations/fork-sync.md:397`). A race is a push failure and fresh sign-off, not an update (`.agents/skills/fork-sync/SKILL.md:116`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Upstream-sync mirror     | The mirror moves only `main` by an unforced fast-forward and creates missing fetched tags with an unforced `--tags` push; rejection is a failure (`.github/workflows/hyprws-upstream-sync.yml:53`, `.github/workflows/hyprws-upstream-sync.yml:57`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Upstream-sync rebase bot | `off` moves no rebase ref. `candidate` creates stable snapshots, then force-updates bot-owned `hyprws-next`. `on` dry-runs the exact-old trunk lease, creates snapshots, force-updates bot-owned `hyprws-previous`, and finally rewrites `hyprws` with the same exact-old lease (`scripts/fork-auto-rebase.ts:806`, `scripts/fork-auto-rebase.ts:820`, `scripts/fork-auto-rebase.ts:824`, `scripts/fork-auto-rebase.ts:829`, `scripts/fork-auto-rebase.ts:832`). A trunk lease race rolls snapshots and `hyprws-previous` back while preserving the racing trunk (`scripts/fork-auto-rebase.ts:837`). Tests assert ref allowlists, ordering, create-only refusal, and race rollback (`scripts/fork-auto-rebase.test.ts:857`, `scripts/fork-auto-rebase.test.ts:885`, `scripts/fork-auto-rebase.test.ts:909`, `scripts/fork-auto-rebase.test.ts:939`). Low-level token injection and rollback live in `scripts/lib/fork-rebase-push.ts` (`scripts/lib/fork-rebase-push.ts:51`, `scripts/lib/fork-rebase-push.ts:70`). |
| Release workflow         | The release action creates the generated nightly tag or uses the already-created stable tag at the preflight SHA (`.github/workflows/hyprws-release.yml:332`). Stable tags are never updated by this workflow. Nightly retention deliberately deletes only old prerelease releases and their tags (`.github/workflows/hyprws-release.yml:352`, `.github/workflows/hyprws-release.yml:400`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Do they agree?

The differences are intentional and ref-specific:

- Given old trunk `A` and verified rewrite `B`, human unblock may move only `hyprws` from exactly
  `A` to `B`. Bot `on` mode may additionally save `A` to `hyprws-previous`; candidate mode may move
  only `hyprws-next`. Both trunk writers refuse a changed `hyprws` through an explicit expected-old
  lease.
- Force is limited to replaceable bot-owned state: `hyprws-next`, `hyprws-previous`, and rollback of
  a bot transaction. A `release/*` snapshot and a stable fork tag are create-only. “Bot-owned” means
  the bot may replace the two rolling support refs, the bot may create but not advance a release
  snapshot, and humans move none of the three (`docs/operations/fork-sync.md:63`,
  `docs/operations/fork-sync.md:68`).
- `main` needs no force or lease because the mirror is its only writer and accepts only a
  fast-forward. Stable tag creation needs no expected-old lease because absence is the precondition
  and Git rejects a concurrent creation. Nightly deletion is retention policy, not a rewrite of a
  stable or sync ref.

No concrete input produces conflicting authorization under the declared single-writer and bot-owned
ref assumptions. An out-of-policy human move of `hyprws-next` is overwritten by the bot rather than
protected by a lease, but that is the meaning of a replaceable bot-owned candidate, not a second
human lane.

### Verdict

**Intentional.** The lanes agree that trunk rewrites require an exact expected-old lease, while the
force and create-only differences follow each ref's declared lifetime.

### Consolidation target

`scripts/lib/fork-rebase-push.ts` is the right existing destination for push construction because it
already isolates credentials and remote rollback. It should own pure builders for exact-old trunk,
replaceable bot ref, and create-only ref updates; `scripts/fork-auto-rebase.ts` has the strongest
executable policy and tests from which to extract them. Human `fork-sync` should consume the
exact-old builder without gaining bot credentials or bot-ref authority. Workflow-level `main` and
release pushes remain explicit because their fast-forward, tag-creation, and retention policies are
not rebase pushes.
