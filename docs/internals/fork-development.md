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

### Guided stable-tag sync

Run upstream stable-tag rebases through the repo-local [`fork-sync`](../../.agents/skills/fork-sync/SKILL.md)
skill. Its five gates keep the rewrite on a rehearsal branch, commit the record under
[`docs/operations/fork-sync-records/`](../operations/fork-sync-records/), and stop before the human-only
lease push and release.

Rebase the fork trunk onto upstream history.
Do not merge `upstream/main` into `hyprws`, because repeated merge commits obscure the patch stack.

Rebase onto a stable upstream tag, never onto an untagged commit and never onto a nightly.
A tag is a state upstream chose to ship, the fork release takes its version from it, and the apply
gate refuses anything that is not `vX.Y.Z`.
When the fork needs a fix upstream has merged but not released, trial it in a worktree and take the
stable tag that carries it.

[Fork sync](../operations/fork-sync.md) owns the invariants a sync must not break, and the
[`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill owns every command that runs one.
The rebase itself happens on a disposable `rehearse/<tag>` branch cut from `origin/hyprws`, so the
`hyprws` worktree is never rewritten in place and never needs to be clean.

Before resolving anything, walk the rebase scan in [Fork delta](./fork-delta.md) for every active domain.
It names the upstream paths that would silently invalidate a domain, including the ones that would retire it outright.

A clean rebase is not evidence that a domain is still needed.

### Upstream watch

A fork bug that upstream already tracks is not fixed twice.
It gets a fork issue labelled `upstream-watch` whose body cites the upstream issue or pull request in a
code span, and that issue is re-read at the orient step of every sync.

`vp run fork:upstream-watch` is that re-read.
It resolves each cited item against the rebase target and says whether the fix is already contained in it.
The runbook's [orientation section](../operations/fork-sync.md#re-read-what-waits-on-upstream) owns the verdicts.

The issue closes only once the upstream fix rides in a fork release and has been verified there, with the
upstream merge commit and that release named in the closing comment.
A watch label without a citation is not a watch; it is a forgotten issue.

Run focused verification after resolving conflicts, including `vp run fork:delta --check`.
Then a human publishes the rewritten branch with an explicit expected-old lease against the published
head the sync read.

The explicit lease refuses to overwrite remote work that appeared after the fetch.
Never replace it with an unguarded force push or silently refresh a rejected lease.

If the lease fails, fetch and inspect the new remote commits before deciding how to reconcile them.
A rejected lease is evidence that the published branch changed, not an inconvenience to bypass.

### Conflict policy

Read the upstream change before choosing a resolution.
Preserve upstream intent first, then reapply the smallest fork behavior on the new seam.

Git rerere may replay a previous resolution, but its output is only a candidate.
Review and verify every reused resolution because upstream behavior may have changed.

When upstream makes a fork patch obsolete, retire it by exact subject through the human decision in
[Fork delta](./fork-delta.md); a rebase never drops one on its own.
When upstream moves the architecture, rebuild the behavior at the new boundary instead of preserving dead structure.

## Releases

The fork ships its own Linux desktop build, because an upstream release carries upstream code.

A fork tag is `v<upstream version>-hyprws.<n>`, for example `v0.0.34-hyprws.1`.
`<upstream version>` is the `X.Y.Z` of the upstream tag the stack is rebased onto.

`<n>` counts up within one upstream version and restarts at 1 when that version changes.

The release body names the exact upstream tag, so the base is never ambiguous.

`.github/workflows/hyprws-release.yml` builds the AppImage and publishes a normal GitHub release, never a prerelease.
The desktop updater reads its feed from the building repository, so a fork build updates from fork releases.

[Fork sync](../operations/fork-sync.md) owns the release invariants and the runner setup.

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
