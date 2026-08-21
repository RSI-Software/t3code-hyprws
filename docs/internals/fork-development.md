# Fork development

> Fork-only maintainer guide for `RSI-Software/t3code-hyprws`.

This fork makes T3 Code feel like opening an editor on a project, not opening one global dashboard.
Each project should have an obvious window that can live beside its editor, terminals, and browser.

The goal is a small, durable patch stack on top of upstream T3 Code.
This document defines the product direction and the development discipline that keeps that stack rebasing cleanly.

## Product direction

The unit of desktop organization is a physical project in an environment.
Opening a project should reveal its existing window or create a window scoped to that project.

The core value is one project per instance.
The user keeps one project window per Hyprland workspace and navigates by switching workspaces.
A project window opens from the hub UI and from the command line or a Hyprland keybind.

A project window contains only that project's threads, composer state, and project actions.
The existing all-project experience remains available as a hub rather than disappearing.

Until desktop windows land, the project-scoped web route in a browser app window is an acceptable interim project window.
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
  `apps/desktop/src/electron/ElectronWindow.ts` holds one `mainWindowRef`; `DesktopWindow.ensureMain` short-circuits when any window exists; the window loads a fixed URL with no route parameter.
- `apps/desktop/src/app/DesktopClerk.ts` ignores second-instance arguments and shares its path with Clerk/OAuth forwarding.
  A launch-intent parser must coexist with that behavior.
- `apps/desktop/src/preview/Manager.ts` (~4.2k lines) has a single `setMainWindow` slot with last-write-wins semantics, and preview IPC broadcasts to every window via `sendAll`.
  A second window would silently steal preview ownership.
  The preload also exposes preview APIs to every renderer, so project windows must explicitly report previews unsupported; skipping `setMainWindow` alone is not a gate.
- The default sidebar (`apps/web/src/components/Sidebar.tsx`) already has a mutable project filter over a logical project group.
  Convert that seam into a forced physical `ScopedProjectRef` scope in both supported sidebars rather than building filtering from scratch.
- "Current project" is client state today (`activeEnvironmentIdAtom` in `apps/web/src/state/entities.ts`), set from `__root.tsx`.
  `ChatMarkdown.tsx` consumes it for server config and editor actions and should derive the environment from `threadRef` instead, or a remote project window acts through the primary environment.
- Renderer UI state is per-window; content consistency comes free from the shared backend.
  But `composerDraftStore.ts` persists whole-store snapshots to shared `localStorage` with last-write-wins merging: concurrent windows can destroy unsent drafts that never reached the backend.
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

Keep local `main` as an exact mirror of `upstream/main`.
Never put fork commits on `main`, and never merge `project-windows` back into it.

`project-windows` is the maintained fork branch.
Its first-parent story should remain a short, readable sequence of fork decisions above `upstream/main`.

Short-lived branches isolate one concern at a time.
Create fork work from `project-windows` and genuinely upstreamable work from `upstream/main`.

```bash
# Fork-specific work
wt switch --create <branch> --base project-windows

# A change intended for upstream without fork dependencies
wt switch --create <branch> --base upstream/main
```

Choose landing authority when the change is ready.
Use a GitHub pull request when one is open or expected.
Use verified `wt merge project-windows` only for an explicit local or solo landing route.

Do not use raw `git merge` to integrate a feature branch.
It bypasses both Worktrunk verification and the GitHub pull-request lifecycle.

## Commit discipline

Treat every fork commit as a patch that may need to survive hundreds of upstream commits.
Small, coherent commits are easier to rebase, review, reorder, drop, and upstream.

- Keep one concern per commit and use the repository's conventional commit style.
- Separate mechanical refactors from behavior changes.
- Avoid drive-by formatting, renames, dependency bumps, and generated-file churn.
- Prefer narrow additions and upstream-native extension points over broad edits to central modules.
- Reuse upstream terminology and abstractions unless the fork needs a genuinely new concept.
- Add focused tests beside each behavior change so conflict resolutions remain checkable.

The best fork code looks unsurprising inside upstream T3 Code.
Fork branding and local workstation preferences belong in documentation or the desktop boundary, not shared internals.

## Syncing upstream

Rebase the maintained fork branch onto upstream history.
Do not merge `upstream/main` into `project-windows`, because repeated merge commits obscure the patch stack.

Start from a clean `project-windows` worktree, capture the published head, and then rebase.

```bash
git fetch origin upstream
expected_old=$(git rev-parse origin/project-windows)
git rebase upstream/main
```

Run focused verification after resolving conflicts.
Then publish the rewritten branch with an explicit expected-old lease.

```bash
git push \
  --force-with-lease=refs/heads/project-windows:"$expected_old" \
  origin HEAD:project-windows
```

The explicit lease refuses to overwrite remote work that appeared after the fetch.
Never replace it with an unguarded force push or silently refresh a rejected lease.

If the lease fails, fetch and inspect the new remote commits before deciding how to reconcile them.
A rejected lease is evidence that the published branch changed, not an inconvenience to bypass.

### Conflict policy

Read the upstream change before choosing a resolution.
Preserve upstream intent first, then reapply the smallest fork behavior on the new seam.

Git rerere may replay a previous resolution, but its output is only a candidate.
Review and verify every reused resolution because upstream behavior may have changed.

When upstream makes a fork patch obsolete, drop the patch.
When upstream moves the architecture, rebuild the behavior at the new boundary instead of preserving dead structure.

## Implementation order

Build phases that remain useful and reviewable on their own.

1. **Upstream-safe preparation.**
   Derive environment from `threadRef` in `ChatMarkdown.tsx` instead of the active-environment atom.
   Extract route-family-aware thread and draft navigation helpers.
   Convert the existing mutable project filter in both supported sidebars into a controllable physical `ScopedProjectRef` scope.
2. **Additive web scope.**
   Add the project route subtree with scope preservation and mismatch rejection.
   Decide hub-versus-scoped behavior for settings and pull requests.
   This phase is immediately usable as a browser app window through portless.
3. **Desktop MVP without previews.**
   Add the desktop-boundary `WindowIdentity` registry with create, reveal, close, and destroyed-window cleanup.
   Route first-launch and second-instance intent; define restoration policy; set per-project titles; persist bounds per identity or hub-only.
   Explicitly disable preview capability in project windows.
   Resolve composer-draft `localStorage` clobbering before allowing concurrent windows.
4. **Optional previews.**
   Namespace preview ownership and tab ids, authorize IPC by sender, and direct events to the owning window.

Upstreaming is a bonus, not a sequencing constraint.
Phase 1 items and possibly the project route are upstream-PR candidates; the window machinery is fork-only.

Do not optimize server subscriptions before project-scoped windows are correct.
Measure WebSocket traffic and renderer work before moving filtering across the RPC boundary.

### Residual risks

- `Sidebar.tsx` remains a large upstream-conflict surface even with additive routes.
- Restoring or launching a remote project must handle an unavailable environment without creating duplicate or unscoped windows.
- Other persisted Zustand stores may also have last-writer-wins behavior; composer drafts are the known content-loss risk.

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
