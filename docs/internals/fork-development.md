# Fork development

> Fork-only maintainer guide for `RSI-Software/t3code-hyprws`.

This guide owns fork-wide development discipline and the `project-windows` domain architecture.
The [fork delta](./fork-delta.md) owns the need and retirement condition for every domain.

The goal is a small, durable patch stack on top of upstream T3 Code.
Project windows make T3 Code feel like opening an editor on a project, not one global dashboard.
Each project should have an obvious window that can live beside its editor, terminals, and browser.

## What the sync machinery is for

The fork stays small, replayable, and in sync with upstream without a person in the loop.
The bot carries most upstream tags on its own, and an agent runs only when a walk stops at a real judgement: a retire question, or a behaviour seam.
A conflict that reaches an agent is genuine, new upstream work meeting new fork work, never a seam the churn ledger already named.

Before adding to the fork, run `vp run fork:scan --no-typecheck` and read its declared lesson ref, exact SHA, freshness and preferred boundaries alongside the latest sync report's `## Churn` section.
Use `--offline` explicitly when working from retained evidence.
Prefer one adapter boundary over edits spread across upstream files, and see [Ledger guards run in the scan](#ledger-guards-run-in-the-scan) for the guard every ledger action ships.

The measure is consecutive tags carried with the bot on and no agent stop, plus ledger rows that read `mechanical: 0`.
Tracked in RSI-Software/t3code-hyprws#443.

### Census evidence

Blocked reports distinguish sequential replay observations from pairwise feasibility overlap.

| Aspect             | Rule                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| Row retains        | source, base, target, stop ordinal, replayed commit, path, Git conflict kind |
| Totals             | derived from those same rows                                                 |
| Continuation       | provisionally takes the fork-side index stage or deletion, rerere disabled   |
| Resolution verdict | none recorded                                                                |
| Hunk counts        | unknown for these observations, not zero                                     |

Versioned `sequential-census-v2` evidence survives in the churn ledger as `censusEvidence` and records each row's seam shape.

| Shape      | Meaning                                  |
| ---------- | ---------------------------------------- |
| `hooked`   | Keyed on the manifest keys that carry it |
| `woven`    | Keyed on its location                    |
| `addition` | Fork-owned at that position              |

Shape is what makes carry cost computable, so an unprovable seam records `woven` and over-counts recurring cost rather than flattering the fork.
A stored `v1` row carries no shape and keeps the identity it was minted with; the two schemes never compare, so a `v1` observation can never establish that a `v2` seam is absent.
Legacy rows without that provenance stay labelled pairwise feasibility overlap, and their old aggregate census counts have no retained stop rows.
Method changes and partial censuses break comparison continuity, so neither can prove a seam disappeared.
A partial census remains useful evidence but cannot decide a clean replay.

### Seam identity

The churn reporter keeps unresolved seam identities through ordinary replays.
A hooked seam is kept on its manifest keys, so a path or subject rewrite does not mint a new one, and every other seam is kept on its path, subject and domain.
An absent seam is only not observed; it is never an inferred repair.
Before changing a seam's path, subject or patch split, store its full census and reviewed aliases with `fork:churn record`.
A repair names its change and guard, and a separate maintainer-attested verification names the comparable replay and guard result.
Returned unresolved seams and verified regressions remain blocking until comparable repair evidence clears them.
See [Churn ledger](../operations/fork-sync.md#churn-ledger).

## Project-window direction

The unit of desktop organization is a physical project in an environment.
Opening a project should reveal its existing window or create a window scoped to that project.

The core value is one project per instance: one project window per Hyprland workspace, navigated by switching workspaces.
A project window opens from the hub UI, the command line, or a Hyprland keybind.
It contains only that project's threads, composer state, and project actions, and the existing all-project experience remains available as a hub.

Until desktop windows land, a browser app window on the project-scoped web route is an acceptable interim.
Serve it through portless so each window has a stable named `.localhost` origin instead of a shifting port.

Hyprland owns placement across workspaces and monitors, so T3 Code exposes normal, independently placeable desktop windows and never becomes a window manager itself.
Worktrunk owns Git worktrees and development lanes, zmux owns long-running terminal sessions, and editors and browsers remain separate visual tools.

## Non-goals

| Never               | Detail                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Per-window backend  | No separate T3 server, database, provider runtime, or authentication stack per project window |
| Second frontend     | Do not duplicate the web application into a desktop-only client                               |
| Compositor policy   | Do not encode Hyprland workspace policy inside T3 Code                                        |
| Removal             | Keep the hub, remote environments, the web client, and mobile project navigation              |
| Gratuitous rewrites | Do not rewrite unrelated upstream systems to make the fork feel internally unique             |

`dev:desktop:agent` is the narrow development-tooling exception to the compositor-policy rule.
It relays an explicit relative or absolute numbered-workspace request into a disposable dev process; shipped application launches still leave placement to Hyprland.

## Testing a fork checkout

`vp run dev:app` is the shared launcher, defaulting to `--external`.
The checked-in **Dev Web** T3 action passes `--preview` explicitly so a native agent can call `preview_open` with the actual ready URL printed after startup, and uses the external browser when integrated preview is unavailable.

`--desktop` uses the same checkout-local home and fixture project while adding an isolated `.t3/electron` profile, Electron CDP, and optional `--workspace <+1|-1|id|none>` placement.
The profile scopes Electron and Clerk state plus the single-instance lock without changing provider credential discovery.
Relative placement captures the invoking app's numbered workspace once, absolute ids target that workspace directly, and `none` requests normal compositor placement.
An action override outranks the saved `T3CODE_DESKTOP_AGENT_WORKSPACE` value, and targeted windows map without taking focus.

Launch from the base checkout for exploration, the implementation worktree for feature work, or a checkout pinned to the exact candidate SHA for UAT.
One backend owns one checkout-local `.t3` home at a time, so stop it before switching surfaces for that checkout; distinct checkouts have distinct homes and may run concurrently.
Relaunches retain `.t3/test-project`, its edits, registered project, threads, and authentication.
Never reset that fixture or copy the stable installation's state into it.

T3 imports checked-in `t3.json` scripts once and stores project-owned copies, so update those copies when a checked-in command changes.
**Setup Worktree** only prepares a checkout; it does not launch the app or recreate fixtures.

The convenience actions target local checkouts.
**Dev Web** requires the primary local environment, because remote, relay, and SSH loopback URLs would open on the wrong machine; use the existing shared-development workflow for remote access.
Pairing recovery from either base or a worktree uses `node apps/server/src/bin.ts pair --base-dir "$PWD/.t3"`, because a bare `pair` in the base checkout may select the installed home.

## Architectural direction

This section records the grounded target shape, verified against the code on 2026-08-22.
Re-verify the "current reality" notes after each upstream rebase.

Keep one Electron process and reuse the existing backend pool and environment registry.
Add multiple `BrowserWindow` instances whose renderer routes carry an explicit project scope.

### Scope identity

Model window identity at the desktop boundary only:

```ts
type WindowIdentity =
  { readonly kind: "hub" } | { readonly kind: "project"; readonly ref: ScopedProjectRef };
```

`ScopedProjectRef` combines `environmentId` and `projectId`.
Both are required because project ids are unique only within their environment.

Do not thread a codebase-wide scope union through web or shared packages; on the web surface the route itself is the scope.
Do not reuse `projectKey` as identity, because it names a logical grouping that can span multiple physical projects.

### Routes

Add an additive project subtree rather than extending the hub `_chat` grammar:

```text
/project/$environmentId/$projectId/thread/$threadId
/project/$environmentId/$projectId/draft/$draftId
```

The additive subtree leaves hub routes untouched, which rebases better against upstream.

The renderer URL is the recoverable source of truth for scope.
A reload or renderer crash must reconstruct the same project window without transient IPC state.
Scope must survive thread selection, draft creation and promotion, missing-thread redirects, and new-thread actions.

Reject project/thread mismatches instead of silently escaping scope.
Decide explicitly whether settings and pull requests open in the hub or gain scoped routes.

### Registry

The desktop main process owns a registry from `WindowIdentity` to live `BrowserWindow`.
Opening an identity that is already registered reveals and focuses that window instead of creating a duplicate.

Shared services remain shared unless measurement proves that isolation is required.
That includes the backend pool, connection runtime, settings, authentication, providers, and persisted state.

### Current reality (verified 2026-08-22)

| Area              | Reality today                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window machinery  | Singleton-shaped. `apps/desktop/src/electron/ElectronWindow.ts` holds one `mainWindowRef`, `DesktopWindow.ensureMain` short-circuits when any window exists, and the window loads a fixed URL with no route parameter                                                                                                   |
| Launch intent     | `apps/desktop/src/app/DesktopClerk.ts` ignores second-instance arguments and shares that path with Clerk/OAuth forwarding, so a launch-intent parser must coexist with it                                                                                                                                               |
| Preview ownership | `apps/desktop/src/preview/Manager.ts` (~4.2k lines) has one last-write-wins `setMainWindow` slot, and preview IPC broadcasts to every window via `sendAll`, so a second window would silently steal preview ownership                                                                                                   |
| Preview gating    | The preload exposes preview APIs to every renderer, so project windows must explicitly report previews unsupported; skipping `setMainWindow` alone is not a gate                                                                                                                                                        |
| Sidebar filter    | `apps/web/src/components/Sidebar.tsx` already filters over a logical project group. Force that seam to a physical `ScopedProjectRef` scope in both supported sidebars rather than building filtering from scratch                                                                                                       |
| Current project   | Client state today: `activeEnvironmentIdAtom` in `apps/web/src/state/entities.ts`, set by `__root.tsx` and read by `ChatMarkdown.tsx` for server config and editor actions. Derive the environment from `threadRef` there, or a remote project window acts through the primary environment                              |
| Draft persistence | Renderer UI state is per-window and content consistency comes free from the shared backend, but `composerDraftStore.ts` persists whole-store snapshots to shared `localStorage` with last-write-wins merging. Concurrent windows can destroy unsent drafts that never reached the backend; resolve before allowing them |

### Ownership seams

| Area                | Existing seam                                            | Fork responsibility                                                                              |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Window lifecycle    | `apps/desktop/src/window/DesktopWindow.ts`               | Create, reveal, restore, and close scoped windows; per-identity titles and bounds                |
| Native registry     | `apps/desktop/src/electron/ElectronWindow.ts`            | Track windows by `WindowIdentity`                                                                |
| Launch routing      | `apps/desktop/src/app/DesktopClerk.ts`                   | Route first-launch and second-instance intent to the correct window                              |
| Renderer scope      | `apps/web/src/routes/`                                   | Additive project subtree; scope recovery from the URL                                            |
| Sidebar scope       | `apps/web/src/components/Sidebar.tsx` (+ legacy sidebar) | Force the existing project filter to the window's physical scope                                 |
| Client selectors    | `apps/web/src/state/entities.ts`                         | Derive environment/project from route or `threadRef`, not a global atom                          |
| Draft persistence   | `apps/web/src/composerDraftStore.ts`                     | Make persisted drafts safe across concurrent windows                                             |
| Preview ownership   | `apps/desktop/src/preview/Manager.ts`                    | Phase 3: report unsupported in project windows; Phase 4: namespace tabs and IPC by owning window |
| Shared client logic | `packages/client-runtime`                                | Keep reusable project and thread behavior platform-neutral                                       |

Prefer adapting these seams over introducing a parallel application architecture.
Change contracts or server subscriptions only when a client-only scope cannot provide correct or performant behavior.

## Multi-surface rule

Desktop gains operating-system windows, and web retains a project-scoped route that behaves correctly in a normal browser tab.
Mobile does not need desktop window management, but shared project and thread behavior still belongs in `packages/client-runtime` when web and mobile both need it.

Local, remote, relay, and tunnel connections must resolve the same scoped project reference.
Never assume a project ID is globally unique or that every project belongs to the local environment.

## Repository model

The remotes have distinct authority.

| Name       | Repository                   | Purpose                                  |
| ---------- | ---------------------------- | ---------------------------------------- |
| `upstream` | `pingdotgg/t3code`           | Canonical T3 Code history; fetch only    |
| `origin`   | `RSI-Software/t3code-hyprws` | Fork branches and published fork history |

`origin` is the implicit collaboration remote for source-control reads, writes, and pull requests.
`upstream` is fetch-only unless the human explicitly authorizes an operation against `pingdotgg/t3code`.

**The fork posts nothing to `pingdotgg/t3code`.**
No pull request, issue, comment, review, or reaction; reading upstream stays fine, writing to it does not.
This is a baseline rule, not a preference: it holds until at least 2026-11-27, may hold permanently, and only the human may lift it.

`Fork-Upstreamable: yes` is a tracking tag only.
It marks a commit upstream is likely to supersede so the rebase feasibility walk can flag it as a retire candidate; see [Fork delta](./fork-delta.md#trailers).
It never means "send this upstream" and never authorizes publishing a branch or posting to upstream.
The fork tracks upstream and retires superseded commits; it does not contribute to upstream.

Reading upstream is how the fork decides what to do about a bug it feels.
Run the [`upstream-triage`](../../.agents/skills/upstream-triage/SKILL.md) skill before filing or fixing one, so the fork knows whether upstream already fixed it, has a pull request open, or has never seen it.
It reads upstream, writes only in this fork, and drafts any suggestion worth making for the human to decide on.

**Trunk topology.**
Keep local `main` as an exact mirror of `upstream/main`, never put fork commits on it, and never merge `hyprws` back into it.
Push `main` to `origin` only as a fast-forward, so `origin/main` stays a readable mirror.
`hyprws` is the single fork trunk and the GitHub default branch, holding every fork domain as one rebased stack above `upstream/main`.
Its first-parent story should remain a short, readable sequence of fork decisions.

Domains are not branches.
A commit declares its domain with a `Fork-Domain` trailer, and `vp run fork:delta` groups the stack by that trailer.
One trunk means one rebase per upstream sync, one CI target, and one release line.

Per-domain branches were rejected: each long-lived branch is another rebase, another conflict set, and a merge order to reason about.
Reintroduce one only if a domain must ship or be extracted on its own schedule.

### Extracting a domain

One trunk stays honest only while any single domain can leave it.
Someone may want project windows without the rest, or a domain may need to ship on its own schedule.

```bash
git switch -c extract/project-windows upstream/main
git cherry-pick $(vp run fork:delta --domain project-windows --shas)
```

The SHAs come out in stack order, so the cherry-pick replays the domain exactly as it landed.
A conflict during that replay means the domain shares code with another one; resolve it in the extract and record the seam in the domain's rebase scan.

Three rules keep the replay clean:

| Rule                      | Detail                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| One domain per commit     | A commit serving two domains is two lanes                                                 |
| New code in its own files | Every shared upstream file it edits appears in its rebase scan                            |
| Contiguous commits        | Each domain stays contiguous after every upstream rebase, so the replay never interleaves |

### Stack order

Keep the stack sorted from most likely to be superseded upstream to most fork-specific:

1. `upstream-fixes`, tagged `Fork-Upstreamable: yes`
2. `fork-meta` docs and tooling
3. Product domains, commits contiguous

`upstream-fixes` sits first because upstream may make those commits removable.
A generic fix belonging to no product domain is an `upstream-fixes` commit; a product domain's own bugfix stays in that domain.

New commits land at the top of the stack and move down during the next upstream rebase.
Reorder with an interactive rebase only when the stack is otherwise clean, and publish the result with a lease.

### Lanes

Short-lived branches isolate one concern at a time.
Create fork work from `hyprws`.
Use `upstream/main` only for a fix that must carry no fork dependency, so a later rebase can drop it whole.
That base keeps the commit independently removable; it is not a route to contributing the commit upstream.

```bash
# Fork-specific work
wt switch --create <branch> --base hyprws

# A fix with no fork dependencies, so a later rebase can drop it alone
wt switch --create <branch> --base upstream/main
```

Starting from `upstream/main` does not authorize any write against `pingdotgg/t3code`.

### Landing

Land a lane onto `hyprws` by squash, never by merge commit.
A merge commit breaks the linear stack, and the repository only offers squash merging for that reason.
Upstream squashes every pull request the same way.

A lane is one concern, so it squashes to one commit, and that commit must carry the trailers.
`ghb pr merge` writes the pull-request title as the subject and the pull-request body as the squash body.
Title the pull request as a conventional commit and end its body with the trailer block, after any mention.
The landing tool appends `Co-authored-by` to that block, so `vp run fork:delta --check` still reads every trailer.

Use a GitHub pull request when one is open or expected.
Use verified `wt merge hyprws` only for an explicit local or solo landing route.
A `fork-meta` chore that needs no review may commit directly to `hyprws`.
Do not use raw `git merge` to integrate a feature branch, because it bypasses both Worktrunk verification and the GitHub pull-request lifecycle.

`.github/workflows/hyprws-ci.yml` is the fork's required check.
Upstream workflows stay in the tree but are disabled on the fork; see [Fork sync](../operations/fork-sync.md).
`ghb pr merge` refuses a stale merge ref, so rebase onto `hyprws` after a sibling lands before merging.

A fork-sync walk folds linear landings on `hyprws` instead of freezing them.
Non-linear movement (merge commits, a rewritten trunk, a moved shared base or target) still voids the walk; see the [fold rule](../operations/fork-sync.md#the-fold-rule).
`hyprws-next` stays inspection-only.

## Upstream citations

GitHub turns a live cross-repo reference into an event on the item it names.
Writing `pingdotgg/t3code#4379` in a fork issue, comment, or pull-request body posts "mentioned this" on that upstream thread, from the fork's bot account.
The fork does not file upstream, so the backlink is noise on somebody else's issue.

Neutralise the reference and leave the prose alone.

| Case                   | Form                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Inline upstream item   | A code span: `` `pingdotgg/t3code#4379` ``, or the item URL in backticks                                        |
| Pasted upstream survey | One fenced block around the whole list                                                                          |
| Fork item              | Write it in full as `RSI-Software/t3code-hyprws#108`, which GitHub renders as `#108` and links inside this fork |

A bare `#108` does not clear the guard.
GitHub resolves a bare number the fork has never issued against `pingdotgg/t3code`, so `#5779` in a fork body links upstream and posts the backlink.
The guard has no network and cannot tell offline which numbers the fork holds, so it reports every bare number, including one this fork issued.

`vp run fork:upstream-refs <file>` scans a body from a file or stdin, ignores fenced blocks, code spans, and HTML comments, and exits 1 on anything left live.
Run it before publishing an issue, a comment, or a pull-request body.
`.github/workflows/hyprws-ci.yml` runs it on every pull-request body, so a live reference fails the required check instead of landing.

## Commit discipline

Treat every fork commit as a patch that may need to survive hundreds of upstream commits.
Small, coherent commits are easier to rebase, review, reorder, and drop.

Apply that granularity where it preserves rebase intent.
A commit that edits an upstream file, and therefore touches a seam, carries one intent and stays small, because that intent is what re-derives a conflict resolution on rebase.
Inside fork-only paths, granularity is economically irrelevant and needs no curation.

| Rule                              | Detail                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One concern per commit            | Use the repository's conventional commit style                                                                                                                          |
| Split mechanical from behavioural | Separate refactors from behavior changes                                                                                                                                |
| No drive-by churn                 | Avoid stray formatting, renames, dependency bumps, generated files                                                                                                      |
| Narrow additions                  | Prefer upstream-native extension points over broad edits to central modules                                                                                             |
| Upstream vocabulary               | Reuse upstream terminology and abstractions unless the fork needs a genuinely new concept                                                                               |
| Tests beside behavior             | Add focused tests so conflict resolutions remain checkable                                                                                                              |
| Frozen installs                   | Use `vp i --frozen-lockfile` in a fork worktree so a routine install cannot drift the lockfile; a real dependency change is its own commit, in the domain that needs it |
| Trailers                          | Tag every fork commit per [Fork delta](./fork-delta.md); `vp run fork:delta --check` must pass                                                                          |

### Never squash a landed stack

Once commits land, the stack is never squashed.
Two exceptions are spent, both tree-neutral and both under a human-authorized expected-old trunk lease with a created and verified archive ref.

| Exception                                       | Shape                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain flatten (RSI-Software/t3code-hyprws#671) | One-time squash, legal because `archive/hyprws-pre-rewrite-<expected-old>` was created and verified first (the one hand-created exception to the bot-owned ref families) and churn aliases for every squashed subject were recorded first |
| Reshape fold (RSI-Software/t3code-hyprws#965)   | `vp run fork:sync fold-reshape` folds a landed reshape squash back into its originating fork commit, tree-neutral by construction, under the same lease and archive requirements                                                          |

The general never-squash rule otherwise stands.
See [Fork strategy principle 4](./fork-strategy.md#principles) for the reasoning behind this asymmetry.

When a walk repair belongs unambiguously to one replayed fork commit, write it as a trailer-free `fixup!` and autosquash it before the leased push.
The autosquash runs from the target so a fixup reaches its owner even below a proved fold, the fold segments are re-proved afterwards by their landings' messages, and a path no fork commit touched needs its owner declared rather than a standalone guess.

### Ledger guards run in the scan

An action the churn ledger records ships its guard in the same change, and the sub-issue carrying that action names the guard it adds.
A rule only prose states is a rule the next walk pays for again.

`vp run fork:scan` collects them over the fork stack:

| Guard             | Fires when                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hot-seam`        | The commit edits a retained ledger hot seam, or a path repeated across distinct census observations. Read the scan's current lesson inventory and preferred boundary before adding to it |
| `upstream-test`   | The commit adds a test block to an upstream-owned test file rather than the `*.fork.test.ts` sibling                                                                                     |
| `footprint`       | One commit edits more than six upstream files, more seam than a single rebase intent should carry                                                                                        |
| `replaced-export` | The commit deletes an upstream-owned export and re-declares the same name                                                                                                                |
| `lockfile`        | The commit changes a lockfile. No domain owns dependency bumps, so every lockfile change warns until one does                                                                            |

The inventory keeps every original [Fork churn](./fork-churn.md) path, including unmapped and unresolved lessons.
A missing path in a later snapshot, or a named guard, does not prove a historical repair.

**Severity.**
General warnings are advisory, and `--strict` makes them fatal.
`--since <ref>` restricts warnings to commits after that ref and makes adopted authoring guards blocking, as in the CI authoring step.
`--replay-of <ref>` returns them to advisory on a rebase rehearsal, which replays every fork commit onto a newer upstream release and so is newly authored under any `--since` ref, but only after the scan proves the head omits that trunk and sits on a tagged upstream commit the trunk has not reached.
Retained historical hot-seam warnings remain advisory without `--strict`.

`AUTHORING_GUARD_TARGETS` in `scripts/fork-scan-guards.ts` supplies the exact paths used by each adopted seam matcher.
Its invariant requires scoped lesson guidance for every target, including retired paths.
Upstream test ownership keeps its generic policy and the two exact file-local harness deferrals instead of inheriting a basename-based boundary recommendation.

### Workflow copies require an explicit review

`workflow-drift` is a blocking `fork:scan` check, including in `fork:sync unblock-check`.
It compares upstream `ci.yml` and `release.yml` at the selected target with the reviews in `.github/fork-workflow-reviews.json` at the selected fork head.
Each review binds the upstream commit and workflow blob, the fork counterpart blob, and an `adapted` or `no-change` rationale.
Checking the reviewed blobs also catches drift after replay, when the merge base is already the target and an ordinary overlap scan has no upstream delta left to see.

Keep prerequisites at the corresponding fork workflow job boundary.
Inspect changes to both upstream workflows before refreshing reviews, because shared install text alone cannot find a new upstream-only step.
Adapt every applicable job before tests or builds run.
Preserve deliberate fork choices such as GitHub-hosted runners and Linux-only release channels with a specific reason.
Record adaptations through the existing `--silent-seam` flow as well as the review manifest.

| Fingerprint          | Command                                  |
| -------------------- | ---------------------------------------- |
| Upstream source blob | `git rev-parse <target>:<upstream-path>` |
| Upstream full commit | `git rev-parse <target>^{commit}`        |
| Committed fork blob  | `git rev-parse HEAD:<fork-path>`         |
| Pending fork edit    | `git hash-object <fork-path>`            |

Commit the reviewed workflow and manifest together, then rerun `fork:scan --target <target>`.
An intentional fork-only workflow edit requires a new fork blob and rationale, but no new upstream tag.
Never refresh fingerprints without reviewing the diff.
Missing, malformed or stale review evidence fails the gate; historical advisory ledger warnings retain their existing behavior.

### Fork tests live in fork-owned files

Put fork-authored test blocks beside an upstream test in `<name>.fork.test.ts` or `<name>.fork.test.tsx`, rather than appending them to the upstream-owned file.
The replayed fork series otherwise conflicts at the same shared insertion seam whenever upstream appends another test.

A fork commit may only append to an upstream test file.
`fork:scan` refuses a changed or removed line in an upstream case, and the additive gate counts a line the replayed tree no longer carries as a finding rather than a pass.
Declaration counting alone reported `findings: 0` while `apps/web/src/localApi.test.ts` lost its `showContextMenu` assertions in `cfd9465bd5f`.
The baseline for both is the `Upstream test files edited in place` table in [`fork-test-divergence.md`](./fork-test-divergence.md), not a second list beside it: a file leaves the baseline by leaving that table, which is the same edit that records its migration.
Deliberately changing what an upstream expectation asserts has its own route, below.

Test ownership follows the selected upstream target tree, including files independently added at the same path by both sides.
The guard recognizes `it`, `test`, `describe` and the repository's `effectIt` alias, including Effect variants such as `effectIt.effect`.
New fork test blocks in a `fork:scan --since` authoring range fail without `--strict`; historical inventory remains advisory.

**Two file-local harness deferrals.**
These exact paths are deferred from the convention:

```text
apps/desktop/src/window/DesktopWindow.test.ts
apps/server/src/server.test.ts
```

Both suites construct the harness in the test module itself.
A sibling that imports an exported helper also registers every upstream test: the focused rehearsal collected 35 tests instead of 9 for `DesktopWindow.fork.test.ts`, and 152 instead of 4 for `server.fork.test.ts`.
The server fork cases also require file-local `exchangeAccessToken` and `getWsServerUrl` helpers, while the desktop cases share the module's hoisted Electron mock.
Extracting that complete setup would create a larger, duplicated harness seam than the test appends it removes.
`fork:scan` reads only these two paths from `UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS`; add no wildcard or domain-wide exemption.

### Diverging from an upstream expectation

The sibling-file rule above is unconditional: a fork case asserting fork behavior always lives in the `*.fork.test.ts` sibling, and no route ever moves it into the upstream file.

Sometimes the fork deliberately changes the behavior an upstream test asserts, as project windows, custom agents, the WYSIWYG editor, or zmux linkage invert something upstream holds true.
A test that is merely inconvenient to satisfy alongside fork code is not divergence: fix the fork code or the fork case, and leave the upstream assertion alone.

Genuine divergence has two parts, and neither edits the upstream assertion's text:

1. **Fork case** in the `*.fork.test.ts` sibling
2. **Superseding declaration** in that same sibling

The upstream file is never touched: not rewritten, not deleted, not skipped in place.
A declaration is an exception, not a convenience: it is legal only when the fork deliberately changed the behavior the case it names asserts.
It must be machine-detectable and gate-visible, a declared structured record, never `it.skip`, `it.skipIf`, a comment-out, or any in-place edit.
A bare skip is how an upstream assertion disappears unnoticed.
The additive gate reports skipped cases as findings, and now reports a deleted line inside a kept case too, the shape RSI-Software/t3code-hyprws#689 recorded, where an assertion vanished while the gate stayed at `findings: 0`.

A declaration carries three parts:

1. The upstream file and test name it supersedes
2. The reason the fork changed the behavior
3. The fork commit that did it

**Why the sibling, not the upstream file.**
A marker written into the upstream test is itself an in-place upstream edit, so every legal divergence would also violate the guard: the guard would carve an exception into the very rule it enforces and parse markers inside a file it treats as untouchable.
Upstream stays byte-identical, and the authoring guard keeps one rule with no exception: an upstream test file is untouchable, always.

**Half of this route is enforced.**
The refusal that sends an author here is live, and so is the baseline that keeps it green over the 56 upstream test files the fork already edits in place.
[`fork-test-divergence.md`](./fork-test-divergence.md) classifies every one, and they are the backlog the guard converts, not exceptions to the rule.
The declaration itself is still prose no tool reads: RSI-Software/t3code-hyprws#716 owns the parser, and until it lands a declaration is a note to the next reader rather than something a gate can act on.
Write one anyway, because the refusal above already forbids the alternative and a declaration written today is what the parser finds.

Once that gate lands it classifies a declaration carrying all three parts as _declared divergence_ instead of a finding, treats the upstream case it names as superseded rather than contradictory, and refuses a sibling case that contradicts an upstream case without one.
`fork:scan` and the additive gate already treat an upstream test file that differs from upstream by even one byte as a finding.
The rebase feasibility walk reads the same declaration to retire it once upstream adopts the behavior.

**Retire condition.**
When upstream adopts the changed behavior, the walk's retire decision deletes the declaration and the contradicting sibling case in the same change.
The upstream file needs no repair, because it never changed.
A sibling case whose declaration is gone is a contradiction waiting for the next suite run.

Proposed concrete syntax (RSI-Software/t3code-hyprws#716 owns the final spelling):

```ts
// In <name>.fork.test.ts, never in the upstream file:
forkSupersedes({
  upstream: "apps/web/src/preview/Manager.test.ts > broadcasts preview events to every window",
  reason: "project windows scope preview ownership to the owning window",
  commit: "<fork-commit-sha>",
});
```

### Extend an upstream export, do not replace it

An upstream-exported schema, list, enum, or switch the fork needs more of stays where upstream declares it.
Deleting that declaration and re-declaring the fork's version, in place or by moving it into a new fork-owned file, reads as a clean rewrite and silently drops every later upstream edit to it.
The rebase replays the fork's copy and never surfaces what upstream added.

Extend it from a fork-owned sibling instead: import the upstream declaration, compose the fork's additions beside it, and export the result under a fork-owned name, leaving the upstream declaration in place for the next rebase to carry.

The best fork code looks unsurprising inside upstream T3 Code.
Fork branding and local workstation preferences belong in documentation or the desktop boundary, not shared internals.

## Syncing upstream

### Bot-first sync

`hyprws` remains one linear fork stack, but the normal upstream sync is automated.
The `hyprws upstream sync` workflow caps the feasibility scan at the newest upstream stable or nightly tag on the first-parent lane, selects the newest clean tag within that horizon, replays the whole stack, verifies its commit messages and fork trailers, and publishes according to `HYPRWS_AUTO_REBASE`.
A conflict is a block only when it makes that newest tagged horizon unreachable; conflicts in untagged commits beyond the horizon are ignored.

The bot owns four supporting ref families:

| Ref                                         | Meaning                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `hyprws-previous`                           | The trunk head before an automatic rewrite                                    |
| `hyprws-next`                               | The verified stack produced in candidate mode                                 |
| `release/vX.Y.Z-hyprws`                     | Create-only snapshot when the stack crosses stable upstream `vX.Y.Z`          |
| `archive/hyprws-pre-rewrite-<expected-old>` | Create-only old trunk retained before a reviewed same-base historical rewrite |

No person or feature lane moves those refs.
The repository starts in candidate mode, so the bot publishes `hyprws-next` without rewriting trunk.
In on mode it saves `hyprws-previous` and updates `hyprws` with an explicit expected-old lease.
Off mode reports without publishing a candidate.
Historical rewrite apply creates and verifies its uniquely named archive before the leased trunk push; a rejected trunk lease retains that archive as failed-attempt evidence and never moves `hyprws-previous`.
[Fork sync](../operations/fork-sync.md) is the runbook for modes, setup, run interpretation, stable cuts, and feature-lane recovery.

The bot never merges `upstream/main` into `hyprws`, targets an untagged commit, or interprets a clean textual rebase as permission to retire a fork patch.
Stable and nightly tags are both upstream states chosen for release; stable fork tags require separate human sign-off on a bot-owned release snapshot before the agent publishes them.

### Unblock review

When the newest upstream tag is unreachable, the bot creates or updates the fork's `rebase-blocked` issue.
Resolve it through the repo-local [`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill's **unblock** entry point.
Its gates orient on the newest selected upstream tag beyond the block, rehearse on `rehearse/<tag>`, scan every active domain, and take the CI verdict on the pushed lane head.

For an objective nightly walk, the walking host proposes the generated decisions and another session records the review verdict.
The durable record binds both sides' provider, model, and session to the target, blocking marker, every non-mechanical verdict, rehearsal evidence, exact pushed-lane CI head, silent seams, and live `expected_old`.
The reviewer is not recorded as human and is not collapsed into the walking agent.
Apply's **nightly review gate** refuses a missing, stale, same-session, or withheld review.

Undefined fork intent, a non-equivalent retire, user-visible behaviour change, a fork domain or tier topology change, any bypass, or evidence that cannot be verified remains a pause for human direction.
Stable release UAT and release approval remain human-owned.

A walk targets the newest offered tag by default, so `unblock-list` prints that tag alone and needs `--all` to print the older ones.
Every rehearsal rebase is run with `diff.algorithm=histogram` alongside `core.commentChar=auto` so adjacent additions that share boilerplate do not collapse into a single false-conflict hunk.
An intermediate slice issue is opened only when a walk stops at a judgement and the operator chooses to bisect; a slice is never the default unit of work.

**Decision cells.**
Every decision cell names its decider.
`unblock-check` and `unblock-refresh` both carry the cells already filled through the regeneration they perform, and the check refuses when a filled cell disagrees with the decision the report carries.
A refresh rebinds the head and the stack size and nothing else: a filled cell survives it, and the only sanctioned way one disappears is its subject leaving the replay, which the refresh names on its own output rather than resetting the cell to `TODO`.
A cell still reading `TODO` is nobody's decision: the churn ledger counts it for neither the agent nor the human, and apply refuses it.
The churn ledger stores nightly proposal and review provenance separately, and agent review never increments the human decision count.

A walk that lands on a later tag also passes the stable tags between the two bases.
A stable upstream tag is snapshotted and announced by whichever lane moves the fork base past it, so the apply publishes those snapshots itself rather than leaving them to a bot that can no longer see them.
Both lanes read one definition of a crossed tag, in `scripts/fork-stable-crossing.ts`.

Before resolving anything, walk the rebase scan in [Fork delta](./fork-delta.md) for every active domain, because it names upstream paths that can silently invalidate or retire a domain.
Read upstream intent first, then reapply the smallest fork behaviour at the new seam.
Rerere output is a candidate, not proof; every reused resolution needs review and verification.

No fork commit is skipped, squashed, reordered, or reworded during an unblock, except for a recorded human `retire` verdict, which authorises dropping exactly the subject it names.
When upstream may have made one obsolete, preserve a buildable result for rehearsal and key the human's keep, retire, or partial decision by exact subject in [Fork delta](./fork-delta.md).
A clean automerge still needs semantic review; on the objective nightly lane that review is the recorded verdict.

After sign-off and a passing gate, the agent's final push uses the full `expected_old` read exactly once at rehearsal start, and gate refusals are never bypassed.
A rejected lease means the published branch moved: fetch and inspect the drift, start a new rehearsal, and repeat the checks and the required review or human decision gate.
Never replace the lease with an unguarded force push or silently refresh it.

Rehearsal records are posted as comments on their `rebase-blocked` issues, and automatic rewrites are recorded in immutable workflow run summaries.
Neither flow adds operational record commits to the replayed stack, and existing files under [`docs/operations/fork-sync-records/`](../operations/fork-sync-records/) are retained as historical evidence only.

### Upstream watch

A fork bug that upstream already tracks is not fixed twice.
It gets a fork issue labelled `upstream-watch` whose body cites the upstream item in a code span.
`vp run fork:upstream-watch` resolves each citation against the selected rebase tag during a human unblock.

The issue closes only after a fork release contains the upstream merge and the behaviour has been verified in that build.
The closing comment names the upstream merge commit and fork release.
A watch label without a citation is not a watch; it is a forgotten issue.

## Releases

The fork ships its own Linux desktop build, because an upstream release carries upstream code.
Stable and nightly builds are separate release and desktop-update channels.

**Stable.**
Tags keep the existing `v<upstream version>-hyprws.<n>` shape, for example `v0.0.34-hyprws.1`.
`<upstream version>` is the `X.Y.Z` of the upstream tag the stack is rebased onto, and `<n>` counts up within one upstream version before restarting at 1 when that version changes.
A maintainer cuts a stable by pushing that tag, and a manual stable dispatch must also run from such a tag ref.
The cut starts from the candidate notification for that snapshot, and one candidate is open at a time: the reconcile closes a candidate once its release tag exists or a newer candidate overtakes it.
Stable releases are normal GitHub releases on the `latest` desktop-update channel.

**Nightly.**
Tags are `vX.Y.Z-hyprws-nightly.YYYYMMDD.<run>`, where `X.Y.Z` is the next stable patch resolved from the desktop package metadata.
`.github/workflows/hyprws-release.yml` publishes a nightly on every landing on `hyprws`, and its six-hour schedule is a fallback that publishes only when the head differs from the newest nightly tag.
A manual dispatch with `channel=nightly` always attempts a build, even when that commit already has a nightly.
Nightlies are prereleases, never become GitHub's latest release, and use the `nightly` desktop-update channel.
When a trunk rewrite leaves the previous channel tag on divergent history, the workflow omits that tag from release-note comparison.

Every release body names its channel and the exact upstream base tag, so neither fact is ambiguous.
The workflow builds one Linux x64 AppImage at the selected commit.
The desktop updater reads its feed from the building repository, so a fork build updates only from fork releases on its selected channel.
[Fork sync](../operations/fork-sync.md) owns the stable release invariants and runner setup.

## Implementation order

Build phases that remain useful and reviewable on their own.

| Phase                           | Work                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Upstream-safe preparation    | Derive environment from `threadRef` in `ChatMarkdown.tsx` instead of the active-environment atom; extract route-family-aware thread and draft navigation helpers; convert the mutable project filter in both supported sidebars into a physical `ScopedProjectRef` scope                                                                                                                              |
| 2. Additive web scope           | Add the project route subtree with scope preservation and mismatch rejection; decide hub-versus-scoped behavior for settings and pull requests. Immediately usable as a browser app window through portless                                                                                                                                                                                           |
| 3. Desktop MVP without previews | Add the desktop-boundary `WindowIdentity` registry with create, reveal, close, and destroyed-window cleanup; route first-launch and second-instance intent; define restoration policy; set per-project titles; persist bounds per identity or hub-only; explicitly disable preview capability in project windows. Resolve composer-draft `localStorage` clobbering before allowing concurrent windows |
| 4. Optional previews            | Namespace preview ownership and tab ids, authorize IPC by sender, and direct events to the owning window                                                                                                                                                                                                                                                                                              |

No phase here is upstream work, because the fork contributes nothing to `pingdotgg/t3code`.
Phase 1 items and possibly the project route are the ones upstream could supersede on its own; the window machinery is fork-only.

Do not optimize server subscriptions before project-scoped windows are correct.
Measure WebSocket traffic and renderer work before moving filtering across the RPC boundary.

### Residual risks

| Risk                     | Detail                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `Sidebar.tsx`            | Remains a large upstream-conflict surface even with additive routes                         |
| Remote project restore   | Must tolerate an unavailable environment, and must not create duplicate or unscoped windows |
| Persisted Zustand stores | Others may also be last-writer-wins; composer drafts are the known content-loss risk        |

## Verification standard

Use the smallest proof that covers the changed boundary.
Backend behavior changes require focused tests for that behavior.

Window lifecycle work should cover creation, duplicate-open focus, closure, restoration, and destroyed-window cleanup.
Route work should cover direct entry, reload recovery, invalid identities, and navigation between hub and project scope.

Run targeted tests, lint, and typechecking for the touched packages.
Run the relevant production build after material desktop or web changes.
A delegated worker runs `vp i` in its own worktree first, and every check it reports ran in that worktree.

Before declaring visible or stateful behavior complete, perform one integrated pass in the real client with permission.
Check web and mobile when shared state or navigation changes apply to those surfaces.

## Decision filter

Prefer the option that makes a project window feel obvious while adding the least permanent machinery.
Reject a shortcut if it makes upstream rebases harder, duplicates shared state, or silently breaks another surface.

The fork is healthy when its behavior is distinctive and its diff is boring.
