# Fork delta

> Fork-only inventory for `RSI-Software/t3code-hyprws`.

[Fork development](./fork-development.md) owns discipline: branch topology, rebase rules, and commit hygiene.
This document owns the inventory: what the fork changes, which domain owns it, and what would let us delete it.

Read this first when deciding whether a change belongs in the fork at all.

## Why the fork exists

Upstream's desktop app is single-window by construction.
`DesktopWindow` exposes only `createMain`, `ensureMain`, and `revealOrCreateMain`.
There is no window registry and no per-window scope.
Electron holds a single-instance lock.
A second launch forwards its arguments to the first window instead of opening another.

That is one global dashboard for every project.
The fork's premise is that a project window is the unit of desktop organization, one per Hyprland workspace.

### The upstream-supported alternative

Point a browser at the same backend and open one project per tab.
Sessions, auth, and state are shared because it is the same server.

That alternative is real, and it costs nothing.
It loses the in-app browser preview, which is desktop-only.
`apps/web/src/components/preview/previewBridge.ts` resolves to `null` without an Electron host.

The fork exists because of that gap and because native windows tile under Hyprland while browser tabs do not.
Close the gap upstream and the fork's core reason to exist closes with it.

## Tiers

Every fork change carries one tier.

| Tier     | Meaning                                            | On retirement                      |
| -------- | -------------------------------------------------- | ---------------------------------- |
| `core`   | The domain does not work without it.               | Deleted with the domain.           |
| `qol`    | Polish. Drop it and the domain still works.        | Reassess individually.             |
| `bugfix` | A defect fix. Note whether upstream reproduces it. | Upstream it, or keep if fork-only. |

A `bugfix` that upstream reproduces is an upstreaming candidate, not fork delta we want to carry.
Send it upstream as its own pull request and drop it from the stack when it lands.

## Domain index

| Domain                              | Status | Tiers present     | Retires when                                  |
| ----------------------------------- | ------ | ----------------- | --------------------------------------------- |
| [project-windows](#project-windows) | Active | core, qol, bugfix | Web preview parity, or upstream multi-window. |
| [fork-meta](#fork-meta)             | Active | qol               | Never. It documents the fork itself.          |

Add a row per domain.
A domain is a reason the fork exists, not a feature area of the app.

## project-windows

### Need

One T3 Code window per project, placeable on its own Hyprland workspace.
It sits beside that project's editor, terminals, and browser.
The hub stays as the all-projects view; it stops being the only view.

### Core

Deleting any of these breaks project windows.

| Commit      | Change                                                        |
| ----------- | ------------------------------------------------------------- |
| `31b434b08` | Centralize thread route navigation.                           |
| `0f54e9214` | Add a physical project scope to the sidebar.                  |
| `e962eba9d` | Add the `project.$environmentId.$projectId` route subtree.    |
| `2d158e764` | Preserve project thread routes across navigation.             |
| `b7864f2c2` | Render the scoped project shell.                              |
| `32c0a08ef` | Wait for scoped project hydration.                            |
| `e65a2b52e` | Register desktop windows by identity.                         |
| `31e7b2875` | Route project window intents.                                 |
| `c7c539c1c` | Isolate project preview and drafts per window.                |
| `b1fa69546` | Share project pathname parsing between web and desktop.       |
| `9255bf06e` | Open forwarded project intents from the single-instance lock. |
| `eb054de76` | Load project scope from hash routes.                          |
| `631b9275d` | Namespace previews by window.                                 |
| `5f33af4f3` | Authorize and route preview IPC by window.                    |
| `f0330ee99` | Enable previews inside project windows.                       |
| `fe19c8d82` | Open project windows from renderer IPC.                       |
| `6ab74a755` | Detect desktop project window support from the web client.    |
| `8d7096b3f` | Open project windows from hub actions.                        |

The web half is bridge-gated throughout.
Without `window.desktopBridge.openProjectWindow` the palette entry, hub button, and keybinding row all disappear.
The web client is unchanged.

### QoL

| Commit      | Tier note                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `a8d819bf7` | Offer retry when a scoped draft fails to start. Fork-only surface.                               |
| `df3497f3f` | `T3CODE_DESKTOP_DEVTOOLS=0` suppresses DevTools, which dev opened once per window. Upstreamable. |
| `c0167e637` | Rename project route tests with the `-` prefix so the TanStack Router generator stops warning.   |

### Bugfixes

| Commit      | Upstream reproduces | Change                                                                                         |
| ----------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `f311547b3` | Yes                 | Starting a thread awaited `t3.json`, which never settles while the environment is unreachable. |
| `400dc3487` | Yes                 | Markdown actions used the global environment instead of the thread's.                          |
| `d79f9ee6c` | No                  | Scoped chrome now mounts while the environment reconnects, instead of rendering nothing.       |

The two upstream-reproducing fixes should be offered upstream.
Each is independent of project windows and rebases cleanly on its own.

### Retirement condition

Delete this domain when either holds:

- The web client gains in-app browser preview, making a browser window or PWA shell per project acceptable.
- Upstream ships its own multi-window or project-scoped window support.

The first is the likely one.
`previewBridge.ts` returning something other than `null` on web is the signal to re-open this question.

Other desktop-only gaps may exist and are not yet enumerated.
Enumerate them before acting on a retirement, because preview parity alone may not be sufficient.

### Rebase scan

After every rebase onto `upstream/main`, check these before trusting a clean merge.

| Path                                                     | Why it matters                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/desktop/src/window/DesktopWindow.ts`               | The window service the fork makes plural. Upstream would land here. |
| `apps/desktop/src/window/WindowIdentity.ts`              | Fork-only. A conflict means upstream added its own identity model.  |
| `apps/desktop/src/app/DesktopClerk.ts`                   | Single-instance lock and deep-link forwarding.                      |
| `apps/desktop/src/preview/Manager.ts`                    | Preview namespacing by window.                                      |
| `apps/desktop/src/ipc/**`, `apps/desktop/src/preload.ts` | The bridge surface the web client gates on.                         |
| `packages/contracts/src/ipc.ts`                          | `openProjectWindow` lives here.                                     |
| `apps/web/src/routes/project.*`                          | Fork-only route subtree.                                            |
| `apps/web/src/routeTree.gen.ts`                          | Generated. Regenerate rather than resolving by hand.                |
| `apps/web/src/components/preview/previewBridge.ts`       | The retirement signal. Read it on every rebase.                     |
| `apps/web/src/components/CommandPalette.tsx`             | Entry point, and a busy upstream file.                              |

## fork-meta

### Need

The fork's own documentation and conventions.
This domain exists so documentation commits are not mis-filed under a product domain.

### QoL

| Commit        | Change                                                |
| ------------- | ----------------------------------------------------- |
| `fa500db88`   | Fork README.                                          |
| _(this file)_ | Fork delta. Self-referential, so no hash is recorded. |

### Retirement condition

Retired with the fork.

### Rebase scan

| Path                                       | Why it matters                                                |
| ------------------------------------------ | ------------------------------------------------------------- |
| `README.md`, `AGENTS.md`, `docs/README.md` | Upstream edits these often and they carry fork-only sections. |

## Recording a change

Tag the commit, then add its row here in the same commit or the one that follows.

```text
feat(desktop): register windows by identity

Fork-Domain: project-windows
Fork-Tier: core
```

`Fork-Tier` is one of `core`, `qol`, or `bugfix`.
A `bugfix` that upstream reproduces also carries `Fork-Upstreamable: yes`.

Every fork commit carries these trailers, including the ones that predate the convention.
A rebase preserves them, so the log stays queryable.

List every fork commit:

```bash
git log --oneline "$(git merge-base upstream/main project-windows)..project-windows"
```

List one domain:

```bash
git log --format='%h %s' --grep='^Fork-Domain: project-windows$' \
  "$(git merge-base upstream/main project-windows)..project-windows"
```

## Adding a domain

A new domain needs its own section with the same six headings, and a row in the domain index.

Answer three questions before opening one:

1. What does upstream not do, stated as behavior rather than implementation?
2. What would upstream have to ship for this domain to be deleted?
3. Which upstream paths does it touch, so a rebase scan can find collisions?

If the third answer is "many files across unrelated systems", the change is probably not a domain.
It is probably a bugfix to send upstream.
