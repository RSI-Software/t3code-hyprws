# Fork delta

> Fork-only inventory for `RSI-Software/t3code-hyprws`.

[Fork development](./fork-development.md) owns discipline: branch topology, rebase rules, and commit hygiene.
This document owns the inventory: each change, its owning domain, and what would let us delete it.

Read this first when deciding whether a change belongs in the fork at all.

The commit list itself is generated, because commit hashes rot on every rebase.

```bash
vp run fork:delta           # Markdown ledger grouped by domain and tier
vp run fork:delta --check   # exit 1 when a fork commit lacks a valid trailer
vp run fork:delta --json    # the same ledger for tooling
```

It reads `upstream/main..HEAD` by default; pass `--base` and `--head` to inventory another range.

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
It loses the in-app browser preview because that preview is desktop-only.
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

## Trailers

Every fork commit carries `Fork-Domain` and `Fork-Tier`.
A `bugfix` also carries `Fork-Upstreamable`, so the ledger can tell an upstreaming candidate from a fork-only fix.

```text
feat(desktop): register windows by identity

Fork-Domain: project-windows
Fork-Tier: core
```

```text
fix(web): stop new threads waiting on an unreachable project file

Fork-Domain: project-windows
Fork-Tier: bugfix
Fork-Upstreamable: yes
```

| Trailer             | Values                        | Required on       |
| ------------------- | ----------------------------- | ----------------- |
| `Fork-Domain`       | A domain from the index below | Every fork commit |
| `Fork-Tier`         | `core`, `qol`, `bugfix`       | Every fork commit |
| `Fork-Upstreamable` | `yes`, `no`                   | Every `bugfix`    |

`vp run fork:delta --check` enforces the table, and fork CI runs it on every push.
A rebase preserves trailers, so the log stays queryable after every sync.

## Domain index

| Domain                              | Status | Tiers present     | Retires when                                  |
| ----------------------------------- | ------ | ----------------- | --------------------------------------------- |
| [project-windows](#project-windows) | Active | core, qol, bugfix | Web preview parity, or upstream multi-window. |
| [fork-meta](#fork-meta)             | Active | qol               | Never. It documents the fork itself.          |
| [distribution](#distribution)       | Active | core              | Never, while the fork ships its own builds.   |
| [upstream-fixes](#upstream-fixes)   | Active | bugfix            | Each commit, when upstream ships the fix.     |

Add a row per domain.
A domain is a reason the fork exists, not a feature area of the app.

## project-windows

### Need

One T3 Code window per project, placeable on its own Hyprland workspace.
It sits beside that project's editor, terminals, and browser.
The hub stays as the all-projects view; it stops being the only view.

### Shape

The core is a project route subtree, a scoped project shell, and a desktop window registry keyed by identity.

Launch intents reach the right window through the single-instance lock and hash routes.
Previews, composer drafts, and preview IPC are namespaced per window.

Entry points are the hub project actions, the command palette, a keybinding, and renderer IPC.
All of them gate on `window.desktopBridge.openProjectWindow`, so the web client is unchanged without the bridge.

QoL covers a retry when a scoped draft fails to start, `T3CODE_DESKTOP_DEVTOOLS=0`, and route test naming.
Two bugfixes reproduce upstream and should be offered there; one is fork-only.

Every provider subprocess receives `T3CODE_PROJECT_ID` and `T3CODE_THREAD_ID`.
A project window is created with its project id as the window title, which Hyprland keeps as `initialTitle`.
Tooling an agent runs from inside a project window can therefore find its own window without guessing from `cwd`.
`ProviderSessionStartInput.projectId` carries the id; the binding persists it so recovery after a restart keeps it.

Run `vp run fork:delta` for the commit list.

### Retirement condition

Delete this domain when either holds:

- The web client gains in-app browser preview, making a browser window or PWA shell per project acceptable.
- Upstream ships its own multi-window or project-scoped window support.

The first is the likely one.
`previewBridge.ts` returning something other than `null` on web is the signal to re-open this question.

Other desktop-only gaps may exist and are not yet enumerated.
Enumerate them before acting on a retirement, because preview parity alone may not be sufficient.

### Rebase scan

After every rebase onto upstream, check these before trusting a clean merge.

| Path                                                     | Why it matters                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/desktop/src/window/DesktopWindow.ts`               | The window service the fork makes plural. Upstream would land here. |
| `apps/desktop/src/window/WindowIdentity.ts`              | Fork-only. A conflict means upstream added its own identity model.  |
| `apps/server/src/provider/providerSessionEnvironment.ts` | `T3CODE_PROJECT_ID` / `T3CODE_THREAD_ID`; every adapter calls it.   |
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
This domain exists so documentation and tooling commits are not mis-filed under a product domain.

### Shape

- The fork sections in `README.md`, `AGENTS.md`, and `docs/README.md`.
- This document, [Fork development](./fork-development.md), and the [Fork sync](../operations/fork-sync.md) runbook.
- `scripts/fork-delta.ts` with its `fork:delta` alias in the root `package.json`.

### Retirement condition

Retired with the fork.

### Rebase scan

| Path                                       | Why it matters                                                |
| ------------------------------------------ | ------------------------------------------------------------- |
| `README.md`, `AGENTS.md`, `docs/README.md` | Upstream edits these often and they carry fork-only sections. |
| `package.json` scripts block               | `fork:delta` sits between upstream aliases.                   |
| `docs/internals/scripts.md`                | Carries the `fork:delta` entry.                               |
| `scripts/*.ts` siblings                    | The ledger script copies their Effect CLI shape.              |

## distribution

### Need

Upstream releases ship upstream code, so a fork user needs a fork build and a fork update feed.
Upstream's workflows also target Blacksmith runners the fork does not have.

### Shape

- `.github/workflows/hyprws-ci.yml` runs checks, tests, the fork ledger, and the desktop build on `hyprws`.
- `.github/workflows/hyprws-release.yml` builds a Linux x64 AppImage from a `v*-hyprws.*` tag and publishes it.

Both run on GitHub-hosted runners, which are free for a public repository.

The updater needs no code.
`scripts/build-desktop-artifact.ts` derives the update feed from `GITHUB_REPOSITORY`.
Fork builds therefore update from fork releases.

Upstream workflows stay in the tree untouched and disabled.
Editing or deleting them is a standing rebase conflict.
[Fork sync](../operations/fork-sync.md) owns the disable step.

### Retirement condition

Retired with the fork, or when upstream publishes builds the fork can ship unchanged.

### Rebase scan

| Path                                          | Why it matters                                              |
| --------------------------------------------- | ----------------------------------------------------------- |
| `.github/workflows/ci.yml`                    | Copy new checks or setup steps into `hyprws-ci.yml`.        |
| `.github/workflows/release.yml`               | Copy Linux build-step changes into `hyprws-release.yml`.    |
| `scripts/build-desktop-artifact.ts`           | Build inputs, icon tooling, and the update feed resolution. |
| `scripts/update-release-package-versions.ts`  | Release version alignment the fork workflow calls.          |
| `package.json` `engines` and `packageManager` | Runner toolchain expectations.                              |

## upstream-fixes

### Need

Fixes the fork needs now that belong to no fork domain and would be correct in upstream T3 Code as they stand.
They sit at the bottom of the stack so each one can be offered upstream and dropped without touching a product domain.

### Shape

- One upstream-native commit per fix, `Fork-Tier: bugfix`, `Fork-Upstreamable: yes`.
- A lane created from `upstream/main`, so the fix carries no fork dependency.
- No shared helpers across fixes; each must drop alone.

### Retirement condition

Per commit: upstream ships the fix, and the next rebase drops the commit.
The domain retires when it is empty.

### Rebase scan

| Path                   | Why it matters                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| Each commit's own diff | A conflict usually means upstream fixed it differently; drop ours. |

## Adding a domain

A new domain needs its own section with the same four headings, and a row in the domain index.
Its name becomes the `Fork-Domain` trailer of its first commit.

Answer three questions before opening one:

1. What does upstream not do, stated as behavior rather than implementation?
2. What would upstream have to ship for this domain to be deleted?
3. Which upstream paths does it touch, so a rebase scan can find collisions?

If the third answer is "many files across unrelated systems", the change is probably not a domain.
It is probably a bugfix to send upstream, filed under `upstream-fixes`.

Keep the domain's new code in its own files so `vp run fork:delta --domain <name> --shas` replays it cleanly onto upstream; see [Extracting a domain](./fork-development.md#extracting-a-domain).
