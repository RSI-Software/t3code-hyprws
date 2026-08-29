# Fork development

> Fork-only maintainer guide for `RSI-Software/t3code-hyprws`.

This guide owns fork-wide development discipline and the `project-windows` domain's architecture.
The [fork delta](./fork-delta.md) owns the need and retirement condition for every domain.

Project windows make T3 Code feel like opening an editor on a project, not one global dashboard.
Each project should have an obvious window that can live beside its editor, terminals, and browser.

The goal is a small, durable patch stack on top of upstream T3 Code.
This document defines the project-window direction and the discipline that keeps every domain rebasing cleanly.

## Project-window direction

The unit of desktop organization is a physical project in an environment.
Opening a project should reveal its existing window or create a window scoped to that project.

The core value is one project per instance.
The user keeps one project window per Hyprland workspace and navigates by switching workspaces.
A project window opens from the hub UI and from the command line or a Hyprland keybind.

A project window contains only that project's threads, composer state, and project actions.
The existing all-project experience remains available as a hub rather than disappearing.

Until desktop windows land, a browser app window on the project-scoped web route is an acceptable interim.
Serve it through portless so each window has a stable named `.localhost` origin instead of a shifting port.

Hyprland owns placement across workspaces and monitors.
T3 Code should expose normal, independently placeable desktop windows and avoid becoming a window manager itself.

Worktrunk owns Git worktrees and development lanes.
zmux owns long-running terminal sessions, while editors and browsers remain separate visual tools.

## Non-goals

- Do not run a separate T3 server, database, provider runtime, or authentication stack for every project window.
- Do not duplicate the web application into a second desktop-only frontend.
- Do not encode Hyprland workspace policy inside T3 Code.
- Do not remove the hub, remote environments, the web client, or mobile project navigation.
- Do not rewrite unrelated upstream systems to make the fork feel internally unique.

`dev:desktop:agent` is the narrow development-tooling exception to the compositor-policy rule. It relays the operator's explicit “invoking numbered workspace minus one” request into a disposable dev process; shipped application launches still leave placement to Hyprland.

## Architectural direction

This section records the grounded target shape, verified against the code on 2026-08-22.
Re-verify the "current reality" notes after each upstream rebase.

Keep one Electron process and reuse the existing backend pool and environment registry.
Add multiple `BrowserWindow` instances whose renderer routes carry an explicit project scope.

### Scope identity

Model window identity at the desktop boundary only:

```ts
type WindowIdentity =
  | { readonly kind: "hub" }
  | { readonly kind: "project"; readonly ref: ScopedProjectRef };
```

`ScopedProjectRef` combines `environmentId` and `projectId`.
Both are required because project ids are unique only within their environment.

Do not thread a codebase-wide scope union through web or shared packages.
On the web surface the route itself is the scope.
Do not reuse `projectKey` as identity; it names a logical grouping that can span multiple physical projects.

### Routes

Add an additive project subtree rather than extending the hub `_chat` grammar:

- `/project/$environmentId/$projectId/thread/$threadId`
- `/project/$environmentId/$projectId/draft/$draftId`

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

- All desktop window machinery is singleton-shaped.
  `apps/desktop/src/electron/ElectronWindow.ts` holds one `mainWindowRef`.
  `DesktopWindow.ensureMain` short-circuits when any window exists.
  The window loads a fixed URL with no route parameter.
- `apps/desktop/src/app/DesktopClerk.ts` ignores second-instance arguments.
  It shares that path with Clerk/OAuth forwarding.
  A launch-intent parser must coexist with that behavior.
- `apps/desktop/src/preview/Manager.ts` (~4.2k lines) has a single last-write-wins `setMainWindow` slot.
  Preview IPC broadcasts to every window via `sendAll`, so a second window would silently steal preview ownership.
- The preload exposes preview APIs to every renderer.
  Project windows must explicitly report previews unsupported; skipping `setMainWindow` alone is not a gate.
- `apps/web/src/components/Sidebar.tsx` already has a mutable project filter over a logical project group.
  Convert that seam into a forced physical `ScopedProjectRef` scope in both supported sidebars.
  Do not build filtering from scratch.
- "Current project" is client state today: `activeEnvironmentIdAtom` in `apps/web/src/state/entities.ts`.
  `__root.tsx` sets it.
  `ChatMarkdown.tsx` consumes it for server config and editor actions.
  Derive the environment from `threadRef` there, or a remote project window acts through the primary environment.
- Renderer UI state is per-window; content consistency comes free from the shared backend.
  But `composerDraftStore.ts` persists whole-store snapshots to shared `localStorage` with last-write-wins merging.
  Concurrent windows can destroy unsent drafts that never reached the backend.
  Resolve this before allowing concurrent windows.

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

Desktop gains operating-system windows.
Web should retain a project-scoped route that behaves correctly in a normal browser tab.

Mobile does not need desktop window management.
Shared project and thread behavior still belongs in `packages/client-runtime` when web and mobile both need it.

Local, remote, relay, and tunnel connections must resolve the same scoped project reference.
Never assume a project ID is globally unique or that every project belongs to the local environment.

## Repository model

The remotes have distinct authority.

| Name       | Repository                   | Purpose                                  |
| ---------- | ---------------------------- | ---------------------------------------- |
| `upstream` | `pingdotgg/t3code`           | Canonical T3 Code history; fetch only    |
| `origin`   | `RSI-Software/t3code-hyprws` | Fork branches and published fork history |

- `origin` is the implicit collaboration remote for source-control reads, writes, and pull requests.
- `upstream` is fetch-only unless the human explicitly authorizes an operation against `pingdotgg/t3code`.

**The fork posts nothing to `pingdotgg/t3code`.**
No pull request, issue, comment, review, or reaction; reading upstream stays fine, writing to it does not.
This is a baseline rule, not a preference: it holds until at least 2026-11-27, may hold permanently, and only the human may lift it.
`Fork-Upstreamable: yes` is a tracking tag only.
It marks a commit upstream is likely to supersede so the rebase feasibility walk can flag it as a retire candidate; see [Fork delta](./fork-delta.md#trailers).
It never means "send this upstream" and never authorizes publishing a branch or posting to upstream.
The fork tracks upstream and retires superseded commits; it does not contribute to upstream.

Reading upstream is how the fork decides what to do about a bug it feels.
Run the [`upstream-triage`](../../.agents/skills/upstream-triage/SKILL.md) skill before filing or fixing one, so the fork knows whether upstream already fixed it, has a pull request open, or has never seen it.
The skill reads upstream and writes only in this fork.
Where it finds a suggestion worth making, it drafts one for the human, who decides whether to post it.

Keep local `main` as an exact mirror of `upstream/main`.
Never put fork commits on `main`, and never merge `hyprws` back into it.
Push `main` to `origin` only as a fast-forward, so `origin/main` stays a readable mirror.

`hyprws` is the single fork trunk and the GitHub default branch.
It holds every fork domain as one rebased stack above `upstream/main`.
Its first-parent story should remain a short, readable sequence of fork decisions.

Domains are not branches.
A commit declares its domain with a `Fork-Domain` trailer, and `vp run fork:delta` groups the stack by that trailer.
One trunk means one rebase per upstream sync, one CI target, and one release line.

Per-domain branches were considered and rejected.
Each extra long-lived branch is another rebase, another conflict set, and a merge order to reason about.
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

- One domain per commit; a commit that serves two domains is two lanes.
- New domain code lives in its own files, and every shared upstream file it edits appears in its rebase scan.
- Each domain's commits stay contiguous after every upstream rebase, so the replay never interleaves with another domain.

### Stack order

Keep the stack sorted from most likely to be superseded upstream to most fork-specific:

1. `upstream-fixes` bugfixes tagged `Fork-Upstreamable: yes`, because upstream may make them removable.
2. `fork-meta` documentation and tooling.
3. Product domains, with each domain's commits kept contiguous.

A generic fix that belongs to no product domain is an `upstream-fixes` commit; a product domain's own bugfix stays in that domain.

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

`.github/workflows/hyprws-ci.yml` is the fork's required check.
Upstream workflows stay in the tree but are disabled on the fork; see [Fork sync](../operations/fork-sync.md).

Do not use raw `git merge` to integrate a feature branch.
It bypasses both Worktrunk verification and the GitHub pull-request lifecycle.

## Upstream citations

GitHub turns a live cross-repo reference into an event on the item it names.
Writing `pingdotgg/t3code#4379` in a fork issue, comment, or pull-request body posts "mentioned this" on that upstream thread, from the fork's bot account.
The fork does not file upstream, so the backlink is noise on somebody else's issue.

Neutralise the reference and leave the prose alone.

- Inline, a code span: `` `pingdotgg/t3code#4379` ``, or the item URL in backticks.
- A pasted upstream survey: one fenced block around the whole list.
- A fork item: write it in full as `RSI-Software/t3code-hyprws#108`. GitHub renders that as `#108` and links inside this fork.
  A bare `#108` does not clear the guard. GitHub resolves a bare number the fork has never issued against `pingdotgg/t3code`, so `#5779` in a fork body links upstream and posts the backlink.
  The guard has no network and cannot tell offline which numbers the fork holds, so it reports every bare number, including one this fork issued.

`vp run fork:upstream-refs <file>` scans a body from a file or stdin, ignores fenced blocks, code spans, and HTML comments, and exits 1 on anything left live.
Run it before publishing an issue, a comment, or a pull-request body.
`.github/workflows/hyprws-ci.yml` runs it on every pull-request body, so a live reference fails the required check instead of landing.

## Commit discipline

Treat every fork commit as a patch that may need to survive hundreds of upstream commits.
Small, coherent commits are easier to rebase, review, reorder, and drop.

- Keep one concern per commit and use the repository's conventional commit style.
- Separate mechanical refactors from behavior changes.
- Avoid drive-by formatting, renames, dependency bumps, and generated-file churn.
- Prefer narrow additions and upstream-native extension points over broad edits to central modules.
- Reuse upstream terminology and abstractions unless the fork needs a genuinely new concept.
- Add focused tests beside each behavior change so conflict resolutions remain checkable.
- Tag every fork commit with the trailers in [Fork delta](./fork-delta.md); `vp run fork:delta --check` must pass.

The best fork code looks unsurprising inside upstream T3 Code.
Fork branding and local workstation preferences belong in documentation or the desktop boundary, not shared internals.

## Syncing upstream

### Bot-first sync

`hyprws` remains one linear fork stack, but the normal upstream sync is automated. The
`hyprws upstream sync` workflow uses the feasibility scan to select the newest upstream stable or
nightly tag at or before the conflict-free boundary, replays the whole stack, verifies its commit
messages and fork trailers, and publishes according to `HYPRWS_AUTO_REBASE`.

The bot owns three supporting refs:

- `hyprws-previous`, the trunk head before an automatic rewrite;
- `hyprws-next`, the verified stack produced in candidate mode; and
- `release/vX.Y.Z-hyprws`, a create-only snapshot when the stack crosses stable upstream `vX.Y.Z`.

No person or feature lane moves those refs. The repository starts in candidate mode, so the bot
publishes `hyprws-next` without rewriting trunk. In on mode it saves `hyprws-previous` and updates
`hyprws` with an explicit expected-old lease. Off mode reports without publishing a candidate.
[Fork sync](../operations/fork-sync.md) is the runbook for modes, setup, run interpretation, stable
cuts, and feature-lane recovery.

The bot never merges `upstream/main` into `hyprws`, targets an untagged commit, or interprets a clean
textual rebase as permission to retire a fork patch. Stable and nightly tags are both upstream states
chosen for release; stable fork tags remain a separate human action from a bot-owned release
snapshot.

### Human unblock

A conflict beyond the clean boundary creates or updates the fork's `rebase-blocked` issue. Resolve it
through the repo-local [`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill's **unblock**
entry point. Its five gates orient on the newest selected upstream tag beyond the block, rehearse on
`rehearse/<tag>`, scan every active domain, run focused checks, record human decisions and grounding,
and stop before the human-only leased trunk push.

Before resolving anything, walk the rebase scan in [Fork delta](./fork-delta.md) for every active
domain. It names upstream paths that can silently invalidate or retire a domain. Read upstream intent
first, then reapply the smallest fork behaviour at the new seam. Rerere output is a candidate, not
proof; every reused resolution needs review and verification.

No fork commit is skipped, squashed, reordered, or reworded during an unblock. When upstream may
have made one obsolete, preserve a buildable result for rehearsal and key the human's keep, retire,
or partial decision by exact subject in [Fork delta](./fork-delta.md). A clean automerge still needs
semantic review.

The final human push uses the full `expected_old` read by that rehearsal. A rejected lease means the
published branch moved: fetch and inspect the drift, incorporate it into the rehearsal, and repeat
the checks and human sanity gate. Never replace the lease with an unguarded force push or silently
refresh it.

Human sync records remain under
[`docs/operations/fork-sync-records/`](../operations/fork-sync-records/). Automatic rewrites are
recorded in immutable workflow run summaries instead of adding a commit to the stack on every sync.

### Upstream watch

A fork bug that upstream already tracks is not fixed twice. It gets a fork issue labelled
`upstream-watch` whose body cites the upstream item in a code span. `vp run fork:upstream-watch`
resolves each citation against the selected rebase tag during a human unblock.

The issue closes only after a fork release contains the upstream merge and the behaviour has been
verified in that build. The closing comment names the upstream merge commit and fork release. A watch
label without a citation is not a watch; it is a forgotten issue.

## Releases

The fork ships its own Linux desktop build, because an upstream release carries upstream code.
Stable and nightly builds are separate release and desktop-update channels.

Stable tags keep the existing `v<upstream version>-hyprws.<n>` shape, for example
`v0.0.34-hyprws.1`.
`<upstream version>` is the `X.Y.Z` of the upstream tag the stack is rebased onto, and `<n>`
counts up within one upstream version before restarting at 1 when that version changes.
A maintainer cuts a stable by pushing that tag; a manual stable dispatch must also run from such a
tag ref.
Stable releases are normal GitHub releases on the `latest` desktop-update channel.

Nightly tags are `vX.Y.Z-hyprws-nightly.YYYYMMDD.<run>`, where `X.Y.Z` is the next stable patch
resolved from the desktop package metadata.
`.github/workflows/hyprws-release.yml` publishes a nightly on every landing on `hyprws`; its
six-hour schedule is a fallback that publishes only when the head differs from the newest nightly tag.
A manual dispatch with `channel=nightly` always attempts a build, even when that commit already has a
nightly.
Nightlies are prereleases, never become GitHub's latest release, and use the `nightly` desktop-update
channel.
When a trunk rewrite leaves the previous channel tag on divergent history, the workflow omits that
tag from release-note comparison.

Every release body names its channel and the exact upstream base tag, so neither fact is ambiguous.
The workflow builds one Linux x64 AppImage at the selected commit.
The desktop updater reads its feed from the building repository, so a fork build updates only from
fork releases on its selected channel.

[Fork sync](../operations/fork-sync.md) owns the stable release invariants and runner setup.

## Implementation order

Build phases that remain useful and reviewable on their own.

1. **Upstream-safe preparation.**
   - Derive environment from `threadRef` in `ChatMarkdown.tsx` instead of the active-environment atom.
   - Extract route-family-aware thread and draft navigation helpers.
   - Convert the mutable project filter in both supported sidebars into a physical `ScopedProjectRef` scope.
2. **Additive web scope.**
   - Add the project route subtree with scope preservation and mismatch rejection.
   - Decide hub-versus-scoped behavior for settings and pull requests.
   - This phase is immediately usable as a browser app window through portless.
3. **Desktop MVP without previews.**
   - Add the desktop-boundary `WindowIdentity` registry with create, reveal, close, and destroyed-window cleanup.
   - Route first-launch and second-instance intent; define restoration policy; set per-project titles.
   - Persist bounds per identity or hub-only.
   - Explicitly disable preview capability in project windows.
     Resolve composer-draft `localStorage` clobbering before allowing concurrent windows.
4. **Optional previews.**
   Namespace preview ownership and tab ids, authorize IPC by sender, and direct events to the owning window.

No phase here is upstream work, because the fork contributes nothing to `pingdotgg/t3code`.
Phase 1 items and possibly the project route are the ones upstream could supersede on its own; the window machinery is fork-only.

Do not optimize server subscriptions before project-scoped windows are correct.
Measure WebSocket traffic and renderer work before moving filtering across the RPC boundary.

### Residual risks

- `Sidebar.tsx` remains a large upstream-conflict surface even with additive routes.
- Restoring or launching a remote project must tolerate an unavailable environment.
  It must not create duplicate or unscoped windows.
- Other persisted Zustand stores may also be last-writer-wins; composer drafts are the known content-loss risk.

## Verification standard

Use the smallest proof that covers the changed boundary.
Backend behavior changes require focused tests for that behavior.

Window lifecycle work should cover creation, duplicate-open focus, closure, restoration, and destroyed-window cleanup.
Route work should cover direct entry, reload recovery, invalid identities, and navigation between hub and project scope.

Run targeted tests, lint, and typechecking for the touched packages.
Run the relevant production build after material desktop or web changes.

Before declaring visible or stateful behavior complete, perform one integrated pass in the real client with permission.
Check web and mobile when shared state or navigation changes apply to those surfaces.

## Decision filter

Prefer the option that makes a project window feel obvious while adding the least permanent machinery.
Reject a shortcut if it makes upstream rebases harder, duplicates shared state, or silently breaks another surface.

The fork is healthy when its behavior is distinctive and its diff is boring.
