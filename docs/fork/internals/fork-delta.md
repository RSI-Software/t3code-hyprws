# Fork delta

> Fork-only inventory for `RSI-Software/t3code-hyprws`.

[Fork development](./fork-development.md) owns discipline; this document owns the inventory.
Read it first when deciding whether a change belongs in the fork at all.

The commit list is generated, because hashes rot on every rebase.

```bash
vp run fork:delta           # ledger grouped by domain and tier
vp run fork:delta --check   # exit 1 on a missing or invalid trailer
vp run fork:delta --json    # the same ledger for tooling
vp run fork:delta --inventory --upstream vX.Y.Z # overlap stats per domain
```

Default range is `upstream/main..HEAD`; `--base` and `--head` override it.
The pull-request conflict forecast is informational: one upstream tip, no completeness or freshness guarantee.

## Rebase scans

Each domain's **Rebase scan** table lists the upstream paths its commits touch.

```bash
vp run fork:scan                    # every domain against live upstream/main
vp run fork:scan --target vX.Y.Z    # the same walk pinned to a tag
```

**Shared file:** the fork changed it above its base and upstream changed it too on the way to the target.
`fork:scan` fails when a domain's own commits change a shared file its table omits.
Every code span in a Path cell is one pattern: `*` stays inside a segment, `**` spans them.

| Where                                                                   | Mode                     | Against               |
| ----------------------------------------------------------------------- | ------------------------ | --------------------- |
| Fork CI                                                                 | Advisory, every push     | live `upstream/main`  |
| `scan-live-upstream` in `hyprws-upstream-sync.yml`                      | Advisory, always exits 0 | trunk base            |
| [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) gates 3 and 4 | Blocking                 | human-selected target |

The sync job writes its output and gap count to the step summary.
Upstream moving past the trunk base is normal, so a red run there trains nobody to read it (RSI-Software/t3code-hyprws#1017).
The [fork sync runbook](../operations/fork-sync.md) connects feasibility, bot summary, blocked issue, and human rehearsal.

**Stale fork mocks.** On every rebase, diff each `*.fork.test.*` mock key set against the sibling `*.test.*` mock of the same service.
A key present upstream and absent in the fork sibling is stale even when both suites pass.
The `custom-agents` scan row records the symptom.

## Why the fork exists

The fork carries independent domains upstream does not provide.
Each has its own need, patch boundary, and retirement condition.

Project-scoped windows were the first.
Upstream's desktop app is single-window by construction: no window registry, no per-window scope, and a second launch forwards to the first window.
The premise is that a project window is the unit of desktop organization, each free to live on its own Hyprland workspace.

### The upstream-supported alternative

Point a browser at a self-hosted backend and open one project per window.
One server means shared sessions, authentication, providers, and state, with none of the fork machinery.

Browser mode still trails Electron for terminal workflows and nested in-app browser windows.
`apps/web/src/components/preview/previewBridge.ts` resolves to `null` without an Electron host.
At practical parity, plain browser windows or a small PWA-style Electron shell suffice.
That retires `project-windows`, not the fork.

## Tiers

Every fork change carries one tier.

| Tier     | Meaning                                  | On retirement                       |
| -------- | ---------------------------------------- | ----------------------------------- |
| `core`   | The domain does not work without it      | Deleted with the domain             |
| `qol`    | Polish; the domain works without it      | Reassess individually               |
| `bugfix` | A defect fix; note upstream reproduction | Dropped once upstream supersedes it |

A `bugfix` upstream reproduces is a retire candidate, not delta to carry.
Wait for upstream's own fix, then drop the commit at the next rebase.

Every signalled commit gets one retirement outcome during the rebase.

| Outcome     | Where it lands                                |
| ----------- | --------------------------------------------- |
| **Retire**  | Dropped subject under [Retired](#retired)     |
| **Keep**    | Subject and reason under [Kept](#kept)        |
| **Partial** | Both tables: replacement cell and keep reason |

## Trailers

| Trailer             | Values                        | Required on              |
| ------------------- | ----------------------------- | ------------------------ |
| `Fork-Domain`       | A domain from the index below | Every fork commit        |
| `Fork-Tier`         | `core`, `qol`, `bugfix`       | Every fork commit        |
| `Fork-Upstreamable` | `yes`, `no`                   | Every `bugfix`           |
| `Fork-Wire`         | `reviewed <reason>`           | Reviewed wire exceptions |
| `Fork-Repair`       | The upstream tag of the walk  | Every sync walk repair   |

```text
fix(web): stop new threads waiting on an unreachable project file

Fork-Domain: project-windows
Fork-Tier: bugfix
Fork-Upstreamable: yes
```

`Fork-Upstreamable: yes` is a tracking tag for the feasibility walk, never authorization to post upstream; `AGENTS.md` owns that rule.
`Fork-Repair` marks what a sync walk's repair pass rewrote, which is what keeps that commit out of the replayed fork series.
Historical trailers still parse: `Fork-Budget` rows are inert history (RSI-Software/t3code-hyprws#672, retired by RSI-Software/t3code-hyprws#941) and are not rewritten.
`vp run fork:delta --check` enforces the table on every push, and a rebase preserves trailers.

**Squash-body mode.** Fork CI also runs `vp run fork:delta --check --base origin/hyprws --head <head-sha> --squash-body <file>`, with both refs explicit.

| Rule                                                          | Why                                                 |
| ------------------------------------------------------------- | --------------------------------------------------- |
| Compares the merge-base tree with the exact head              | work already on the base is not a squash change     |
| Validates findings against the body's final trailer paragraph | that paragraph becomes the squash trailers          |
| A trailer carried only by a branch commit cannot satisfy it   | it does not survive the squash                      |
| Historical baseline entries exempt no new pull request        | every new wire exception needs its own body trailer |

[`fork-wire-baseline.md`](./fork-wire-baseline.md) records wire findings that predate the check.
A new commit uses `Fork-Wire: reviewed <reason>` and never adds itself to the baseline.
A baseline key the stack no longer produces is stale; delete it during normal maintenance.

## Wire compatibility

`vp run fork:delta --check` refuses a fork commit that changes a shipped contract under `packages/contracts/src/`.

| Binding                         | Refused change                               |
| ------------------------------- | -------------------------------------------- |
| Exported `Schema.Literals`      | Adds a member                                |
| Exported `Schema.Struct`        | Adds a required field                        |
| Exported `Schema.Struct`        | Removes or renames a field                   |
| Any exported schema             | Removes it, renames it, or switches its kind |
| `packages/contracts/src/ipc.ts` | Any change beyond added optional fields      |

A field is optional when its value uses `Schema.optional`, `Schema.optionalKey`, `Schema.optionalWith`, `withDecodingDefault`, or `withConstructorDefault`.
Keep fork-only contract data in an optional sibling field so released clients still decode the upstream shape.
Restoring a literal or field the upstream base already ships is not a fork wire change.

The check is textual, not a TypeScript AST pass.
It cannot see type widening, on-disk settings migrations, mobile deep-link parameters, or anything outside those bindings; review them separately.

## Carry cost

Decided per commit by the levers retire, reshape, automate, or accept (RSI-Software/t3code-hyprws#665).
There is no numeric cap, budget table, or ceiling arithmetic in any gate.

**Accept is never "as-is".** A kept commit needs a mechanical seam: fork code in fork-only files, and upstream files carrying only marked hook lines the walk re-applies.

### Marking a hook

| Case           | Marker                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| Single line    | trailing `// fork-hook: <domain>/<name>`                                         |
| Multi-line JSX | the pair `{/* fork-hook: <domain>/<name> */}` and `{/* fork-hook-end */}`        |
| Manifest       | every marker also listed in `FORK_HOOKS` in `scripts/lib/fork-hooks.ts`          |
| Charging       | `scripts/lib/fork-hooks.ts` is fork-owned, so its manifest edit is never charged |

**A hook is exactly one construct:** one import, one call, one `const` from a single fork call, one JSX element, one fork-named property or spread, or one re-export.

**A hook never removes or modifies an upstream line**, with two exceptions.

| Exception                                             | Why                                                   |
| ----------------------------------------------------- | ----------------------------------------------------- |
| A marked JSX region may re-indent what it wraps       | a wrap is the only way one JSX element is expressible |
| An in-place substitution removes the line it replaces | the replacing line carries the marker                 |

### The removal rule

One positional rule, run at both ends by `unexplainedRemoval` in `scripts/lib/fork-hook-alignment.ts`.
Align the base side against the fork side over significant lines, and accept a removed base line only when its position falls inside a marked span.

| Case                                         | Result                                           |
| -------------------------------------------- | ------------------------------------------------ |
| A marked hook elsewhere in the file          | absorbs nothing                                  |
| A removal outside every marked span          | refused by the walk, charged by `fork-hook-seam` |
| A needed deletion with no marked replacement | reshape debt with a named reason                 |

**Replay re-application.** At a replay stop the walk re-inserts a marked hook by its manifest anchor when that anchor resolves to exactly one site in the merged upstream text.
Zero sites, several, or an unplaceable end marker leaves an ordinary `conflict` stop naming the hook.

### The `fork-hook-seam` guard

It refuses an addition outside a marked hook, a deletion outside the removal rule, or a marker the manifest does not know.

| Aspect                         | Rule                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Fork side                      | judged by the same rule, rebuilt from the upstream blob and the diff's positions |
| Unreconstructable              | charged, never exempted                                                          |
| Removal gap                    | every addition in it must be a line-kind marked hook                             |
| Outside the rule               | `Fork-Tier: bugfix` with `Fork-Upstreamable: yes`, and generated paths           |
| Generated and dependency files | never reshape debt; the walk restores HEAD and regenerates them                  |
| Historical range               | advisory, so the woven trunk is unaffected                                       |

The guard charges some seams the walk accepts, never the reverse.
It is in `ADOPTED_AUTHORING_GUARDS`.
Each scar rule refuses an inline implementation and directs the author to a fork-owned file, and the narrow call left behind is itself a charged added line, so the two compose only once that call carries a marker.

### Declaration and placement

**Declaration comes from the fork tip, placement from the replayed blob, and the tip wins.**
A seam whose owning commit predates the commit that marked it carries no marker in the blob the walk stands on, so judging from the blob alone would refuse every such seam for where the marker sits in the stack.

| Case                      | Resolution                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| The blob carries a marker | the in-file marker wins                                                                      |
| Otherwise                 | locate the tip's marked span in the fork side                                                |
| Absent or ambiguous       | refuse                                                                                       |
| Absent                    | reported as `tip declares <key> whose code is absent at replay position <sha>; fold pending` |
| Replay position           | threaded in explicitly, never inferred from ambient rebase state                             |

### Measurement

**Measurement informs, it never enforces.** `vp run fork:delta --inventory` measures commits, lines, and shared files per domain.

| Subject                | Rule                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `Fork-Repair` commits  | visible per commit, excluded from domain sums                                  |
| A reshape's census     | read after its fold, never per pull request                                    |
| Every `fork:sync` walk | records commit total, per-domain table, and shared-file count                  |
| That size              | measured at replay completion against the pinned tag, before any repair commit |

`vp run fork:sync fold-reshape` derives the fold manifest that lands a reshape into its originating commit (see [Scripts](./scripts.md)).

**A `.fork.` in a filename is a reader signal only.**
No guard decides on it, and renaming a file changes no scan result.
Its absence proves nothing: a fork-only file without it is an accepted shape.
Its one placement rule is [Fork tests live in fork-owned files](./fork-development.md#fork-tests-live-in-fork-owned-files).

A per-file diff against the base says nothing about seam growth until the path is known to exist upstream.

```bash
git cat-file -e origin/main:<path>   # exit 128: fork-only, residual carries no signal
```

## Domain index

| Domain                                  | Status | Tiers present     | Retires when                                                |
| --------------------------------------- | ------ | ----------------- | ----------------------------------------------------------- |
| [project-windows](#project-windows)     | Active | core, qol, bugfix | Web preview parity, or upstream multi-window                |
| [browser-bookmarks](#browser-bookmarks) | Active | core              | Upstream ships durable project and profile bookmarks        |
| [backend-attach](#backend-attach)       | Active | core              | Upstream ships desktop attach to a running server           |
| [github-issues](#github-issues)         | Active | core, bugfix      | Upstream multi-environment Issues on web and desktop        |
| [custom-agents](#custom-agents)         | Active | core              | Upstream main-thread custom-agent selection                 |
| [markdown-editing](#markdown-editing)   | Active | core              | Upstream ships safe rich Markdown editing                   |
| [workspace-files](#workspace-files)     | Active | core              | Upstream supports ignored and trusted linked artifacts      |
| [fork-meta](#fork-meta)                 | Active | qol               | Never; it documents the fork itself                         |
| [distribution](#distribution)           | Active | core              | Never, while the fork ships its own builds                  |
| [upstream-fixes](#upstream-fixes)       | Active | bugfix            | Each commit, when upstream ships the fix                    |
| [thread-ordering](#thread-ordering)     | Active | qol               | Upstream ships named groups and a return to automatic       |
| [zmux-estate](#zmux-estate)             | Active | core              | Upstream terminals attach to an external session manager    |
| [worktrunk-hooks](#worktrunk-hooks)     | Active | core, bugfix      | Upstream worktree lifecycle exposes create and remove hooks |

A domain is a reason the fork exists, not a feature area of the app.

## Retired

| Fork commit                                               | Domain          | Upstream replacement                                                                                                                                     | Retired at                    |
| --------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| fix(web): scope markdown actions to thread environment    | project-windows | `pingdotgg/t3code#7140` (`082e6ea52`) inlines the same binding in `ChatMarkdown.tsx`, leaving the fork resolver redundant.                               | v0.0.35                       |
| fix(web): upload media in pull request descriptions       | upstream-fixes  | `pingdotgg/t3code#8235` ships typed `image \| file` claims, streamed bodies, and a 50 MB limit. The `gh-image` path stays fork-owned.                    | v0.0.36                       |
| `fix(provider): resolve repo skills per workspace (#188)` | upstream-fixes  | `pingdotgg/t3code#9210` (`bc918e7`) adds per-workspace provider snapshots, superseding the fork's RPC, schemas, atom family, preference, and Codex pair. | v0.0.39-nightly.20260902.1261 |
| feat(web): add manual sidebar thread ordering             | thread-ordering | Upstream persists `activeOrderKey` server side, superseding the fork's client-local order store. Verdict in the RSI-Software/t3code-hyprws#657 walk.     | v0.0.41-nightly.20260908.1414 |
| `fix(web): make sidebar thread ordering direct (#246)`    | thread-ordering | Same `activeOrderKey` path. The order-mode marker is rewritten on top of it under RSI-Software/t3code-hyprws#907, not restored.                          | v0.0.41-nightly.20260908.1414 |
| fix(web): keep sidebar groups in automatic order          | thread-ordering | Grouping now layers over `activeOrderKey`, so the carve-out has no fork order left to protect.                                                           | v0.0.41-nightly.20260908.1414 |

Upstream references here are code-spanned records, never live links.
A retired-only subject must no longer be present in the stack; `fork:delta --check` reports it as `retired but present` until the rebase drops it.

## Kept

| Fork commit                                                                             | Domain           | Reason                                                                                           | Reviewed at                   |
| --------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ | ----------------------------- |
| refactor(web): add physical project sidebar scope                                       | project-windows  | `isProjectInSidebarScope` remains the only physical scope.                                       | v0.0.37-nightly.20260830.1227 |
| fix(web): upload media in pull request descriptions                                     | upstream-fixes   | Partial: the fork-only `gh-image` publication path remains.                                      | v0.0.39-nightly.20260907.1332 |
| fix(web): retain completed thread timing                                                | upstream-fixes   | No upstream completed-turn age, duration, or Done behavior.                                      | v0.0.39-nightly.20260907.1332 |
| `feat(web): add rich Markdown editing (#28)`                                            | markdown-editing | Lockfile churn only; editor and MDX boundary untouched.                                          | v0.0.37-nightly.20260830.1226 |
| refactor(web): centralize thread route navigation                                       | project-windows  | Upstream added no project-window route scoping.                                                  | v0.0.37-nightly.20260829.1224 |
| feat(web): render scoped project shell                                                  | project-windows  | Upstream root-route work gives no scoped shell.                                                  | v0.0.37-nightly.20260829.1224 |
| fix(desktop): isolate project preview and drafts                                        | project-windows  | A wider draft shape is not window namespacing.                                                   | v0.0.37-nightly.20260829.1224 |
| feat(web): open project windows from hub actions                                        | project-windows  | The keybinding rewrite added no bridge actions.                                                  | v0.0.37-nightly.20260829.1224 |
| feat(terminal): attach thread terminals to the checkout's managed zmux session          | zmux-estate      | Settings overlap is not external-session attachment.                                             | v0.0.37-nightly.20260829.1224 |
| feat(server): bind thread worktrees to a managed zmux session                           | zmux-estate      | Upstream binds no thread worktree to zmux.                                                       | v0.0.37-nightly.20260829.1224 |
| One setting drives terminal attach and worktree binding for zmux                        | zmux-estate      | No combined terminal and worktree zmux mode.                                                     | v0.0.37-nightly.20260829.1224 |
| `fix(server): follow external workspace symlinks globally (#66)`                        | upstream-fixes   | No `followExternalWorkspaceSymlinks`; upstream covers skills and themes.                         | v0.0.39-nightly.20260907.1332 |
| feat(issues): add GitHub Issues surface scoped to project windows                       | github-issues    | No upstream Issues list, detail, or hand-off.                                                    | v0.0.37-nightly.20260829.1224 |
| feat(server): run Worktrunk hooks around thread worktrees                               | worktrunk-hooks  | Upstream composition provides no Worktrunk hooks.                                                | v0.0.37-nightly.20260829.1224 |
| fix(web): returning to a thread focuses the composer, not its terminal                  | upstream-fixes   | `ecf3716fd19` refocuses on window-tab-back only.                                                 | v0.0.39-nightly.20260907.1332 |
| feat(web): move Worktrunk hook controls onto the worktree surfaces                      | worktrunk-hooks  | The target adds no Worktrunk controls or lifecycle.                                              | v0.0.37-nightly.20260829.1224 |
| feat: New worktrunk thread mode replaces the Worktrunk hook switches                    | worktrunk-hooks  | No third env mode or wire-safe compatibility pair.                                               | v0.0.37-nightly.20260829.1224 |
| `fix(server): preserve attributed child work (#177)`                                    | custom-agents    | `CHILD_CHATTER_METHODS` still drops `item/*` deltas.                                             | v0.0.39-nightly.20260907.1332 |
| `fix(provider): resolve repo skills per workspace (#188)`                               | upstream-fixes   | Partial: the fork keeps a cwd-keyed probe cache and merges `slashCommands`.                      | v0.0.39-nightly.20260907.1332 |
| `feat(web): group sidebar threads into named sections (#205)`                           | thread-ordering  | No named sections or group-drop behavior.                                                        | v0.0.37-nightly.20260830.1227 |
| `feat(web): add GitHub link destination controls (#178)`                                | github-issues    | No upstream link destination control; the `ChatMarkdown.test.tsx` brand assertion is retargeted. | v0.0.37-nightly.20260829.1224 |
| `docs(fork): consolidate fork documentation for the domain flatten (#671)`              | fork-meta        | Carries the whole fork documentation set.                                                        | v0.0.37-nightly.20260829.1224 |
| `fix(contracts): released clients decode threads from a worktrunk server (#233)`        | worktrunk-hooks  | Theme settings do not replace the wire mode pair.                                                | v0.0.37-nightly.20260829.1224 |
| fix(web): scale titlebar padding with interface zoom                                    | upstream-fixes   | The target lacks the `max()` interface-zoom floor.                                               | v0.0.39-nightly.20260907.1332 |
| `fix(server): provider spawns drop another harness identity (#108)`                     | upstream-fixes   | No `packages/shared/src/env.ts` or `CLAUDECODE` scrub.                                           | v0.0.39-nightly.20260907.1332 |
| fix(web): thread jump keys switch threads while the terminal has focus                  | upstream-fixes   | No `shouldForwardThreadTerminalShortcut`; jump keys stay trapped.                                | v0.0.39-nightly.20260907.1332 |
| fix(web): stop new threads waiting on an unreachable project file                       | project-windows  | `t3ProjectFileDefaults.ts` still awaits `executeAtomQuery` unbounded.                            | v0.0.39-nightly.20260907.1332 |
| fix(server): keep pull requests on origin                                               | upstream-fixes   | The resolver still prefers `upstream` and passes no `--repo`.                                    | v0.0.39-nightly.20260907.1332 |
| Thread terminals and agents stop inheriting the launcher's tmux pane                    | upstream-fixes   | No `TMUX` scrub in `packages/shared` or `apps/server`.                                           | v0.0.39-nightly.20260907.1332 |
| fix: setup script terminals print a completion or failure marker                        | upstream-fixes   | The runner still writes the bare command line.                                                   | v0.0.39-nightly.20260907.1332 |
| `fix(web): keep the files explorer tab when a file opens (#84)`                         | upstream-fixes   | `openFile` still filters out the standalone `files` surface.                                     | v0.0.39-nightly.20260907.1332 |
| feat(web): show which pane owns keyboard focus                                          | upstream-fixes   | No `:focus-within` cue on either host element.                                                   | v0.0.39-nightly.20260907.1332 |
| fix(desktop): use themed app context menus                                              | upstream-fixes   | Renderer menus still go through native `showContextMenu`.                                        | v0.0.39-nightly.20260907.1332 |
| `fix(web): confirm batch worktree deletion once (#156)`                                 | upstream-fixes   | Only the single-thread orphan helper exists.                                                     | v0.0.39-nightly.20260907.1332 |
| `fix(desktop): honor embedded browser wheel zoom (#169)`                                | upstream-fixes   | Guest `zoom-changed` is still unhandled in `preview/Manager.ts`.                                 | v0.0.39-nightly.20260907.1332 |
| `fix(desktop): prevent embedded browser zoom flash (#174)`                              | upstream-fixes   | Window zoom still changes before `reapplyZoom()`.                                                | v0.0.39-nightly.20260907.1332 |
| fix(server): GitManager hook tests pin the fixture hook path                            | upstream-fixes   | The upstream test pins no `core.hooksPath`.                                                      | v0.0.39-nightly.20260907.1332 |
| fix(desktop): keep AppImage launch paths stable                                         | upstream-fixes   | The versioned artifact name still ships; `pingdotgg/t3code#8983` is untagged.                    | v0.0.39-nightly.20260907.1332 |
| fix(server): ignore dependency installs in dev watch                                    | upstream-fixes   | The server dev script is still a bare `node --watch`.                                            | v0.0.39-nightly.20260907.1332 |
| fix(worktree): make setup independent of shell environment                              | upstream-fixes   | `t3.json` still expands through the launching shell.                                             | v0.0.39-nightly.20260907.1332 |
| fix(worktree): bootstrap before Vite+ task discovery                                    | upstream-fixes   | Fork-only ordering; upstream has no `setup-worktree`.                                            | v0.0.39-nightly.20260907.1332 |
| fix(server): exclude dependency churn from watch roots                                  | upstream-fixes   | No per-package source watch roots upstream.                                                      | v0.0.39-nightly.20260907.1332 |
| fix(mobile): finish bounded diff tokenization                                           | upstream-fixes   | `tokenizeTimeLimit` is still never passed.                                                       | v0.0.39-nightly.20260907.1332 |
| refactor(github-issues): the right-panel store surfaces move behind marked hooks        | github-issues    | Retire evidence is circular; no `fork-hooks.ts` upstream.                                        | v0.0.43-nightly.20260917.1880 |
| refactor(github-issues): Issues surface registrations sit behind marked hooks           | github-issues    | Upstream has no hook vocabulary or registration file.                                            | v0.0.43-nightly.20260917.1880 |
| refactor(workspace-files): ignored workspace files sit behind fork-owned seams          | workspace-files  | No `*.fork.ts` counterpart to absorb the seam.                                                   | v0.0.43-nightly.20260917.1880 |
| refactor(web): centralize thread window route scoping behind one fork hook              | project-windows  | Upstream thread routing carries no window scope.                                                 | v0.0.43-nightly.20260917.1880 |
| refactor(agents): custom agents sit behind fork-owned boundaries                        | fork-meta        | Upstream supplies neither the boundaries nor the surface.                                        | v0.0.43-nightly.20260917.1880 |
| refactor(upstream-fixes): pull-request media upload behind marked hooks                 | upstream-fixes   | Only moves the surviving fork half behind markers.                                               | v0.0.43-nightly.20260917.1880 |
| refactor(worktrunk-hooks): move the thread-mode fork boundary behind fork-owned modules | worktrunk-hooks  | The target lacks both the mode and the modules.                                                  | v0.0.43-nightly.20260917.1880 |
| refactor(worktrunk-hooks): thread-mode selector sits behind the enum seam               | worktrunk-hooks  | The target still ships the unextended enum.                                                      | v0.0.43-nightly.20260917.1880 |
| refactor(upstream-fixes): external symlink seams sit behind fork-owned files            | upstream-fixes   | Still no global follow; the seam is fork-owned.                                                  | v0.0.43-nightly.20260917.1880 |
| refactor(web): pull-request project scope supplied by one prop hook                     | project-windows  | The prop hook carries scope the target has no concept of.                                        | v0.0.43-nightly.20260917.1880 |
| refactor(server): child-work custom-agent seams sit behind fork-owned files             | custom-agents    | Files the target does not carry.                                                                 | v0.0.43-nightly.20260917.1880 |
| refactor(web): composer custom-agent seams sit behind fork-owned files                  | custom-agents    | The composer has no upstream attachment point.                                                   | v0.0.43-nightly.20260917.1880 |
| refactor(fork-meta): re-apply carries a multi-line line hook whole                      | fork-meta        | Nothing upstream participates in fork hook re-apply.                                             | v0.0.43-nightly.20260917.1880 |
| refactor(sidebar): isolate physical scope from upstream derivation                      | project-windows  | `SidebarPhysicalScopeContext.tsx` is absent from the target.                                     | v0.0.43-nightly.20260917.1880 |
| refactor(desktop): centralize preview window policy                                     | project-windows  | `WindowPolicy*.ts` is absent from the target.                                                    | v0.0.43-nightly.20260917.1880 |
| fix(desktop): keep preview window policy behind one fork boundary                       | project-windows  | Shares the centralization evidence above.                                                        | v0.0.43-nightly.20260917.1880 |
| refactor(web): isolate project-window pull request scope                                | fork-meta        | The deleted files were fork-created, never upstream.                                             | v0.0.43-nightly.20260917.1880 |
| refactor(web): read physical sidebar scope from an ambient provider                     | project-windows  | The match was an import path segment, not a definition.                                          | v0.0.43-nightly.20260917.1880 |
| refactor(web): share project pathname parsing                                           | project-windows  | The matches are generic helpers it did not introduce.                                            | v0.0.43-nightly.20260917.1880 |

A kept reason documents the fork behaviour the overlap signal did not replace.
A subject in both tables is a partial decision and stays in the active ledger.

## project-windows

### Need

One T3 Code window per project, placeable on its own Hyprland workspace, beside that project's editor, terminals, and browser.
The hub stays as the all-projects view; it stops being the only view.

### Shape

A project route subtree, a scoped project shell, and a desktop window registry keyed by identity.

#### Thread route navigation

Two route families exist: the hub renders every project at `/$environmentId/$threadId`, a project window renders one at `/project/$environmentId/$projectId/thread/$threadId`.
Every navigation must land in the window that issued it, so no upstream chat file hardcodes a route.
`apps/web/src/threadRoutes.ts` defines both families and `resolveThreadRouteFamily`.
`apps/web/src/lib/threadRouteNavigation.ts` is the fork-owned boundary upstream files import.

| Export                                           | Use it when                                                    |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `useThreadRouteFamily()`                         | A component picks the family at render time                    |
| `resolveThreadRouteFamily(params)`               | A callback resolves the family after awaited work              |
| `resolveThreadRouteDeparture(params, threadRef)` | A callback leaves the thread, falling back to the family index |

The hooks read router params at execution time on purpose.
A navigation that awaits first would resolve against render-time params and could leave a project window for the hub.
The blocking `thread-route-navigation` authoring guard keeps direct resolver imports and inline family policy out of those files.

**Call-site budget.** One policy boundary does not imply one call or one patch hunk per file.
Upstream owns where navigation happens; the fork owns only which family it targets.
Each upstream file spends one boundary call per distinct upstream navigation event, plus one hook call when it selects at render time.

| Upstream file                                | Boundary calls | Events served                                           |
| -------------------------------------------- | -------------- | ------------------------------------------------------- |
| `apps/web/src/components/ChatView.tsx`       | 1 hook + 4     | stored draft, new draft, background thread, next thread |
| `apps/web/src/components/CommandPalette.tsx` | 1 hook + 3     | latest thread, searched thread, project-row resume      |
| `apps/web/src/hooks/useHandleNewThread.ts`   | 3              | created draft, raced draft, settled draft id            |
| `apps/web/src/hooks/useThreadActions.ts`     | 1              | leave a deleted thread for its fallback                 |

**Adding a call** means an upstream navigation event gained a route target: edit the table in the same change.
**Collapsing two calls** is correct only when the events themselves merged upstream.
Upstream has no route-family concept, so nothing retires this boundary yet.
An upstream equivalent must preserve hub and project dispatch plus execution-time parameter reads.

#### Windows and IPC

Launch intents reach the right window through the single-instance lock and hash routes.
Previews, composer drafts, and preview IPC are namespaced per window.
Desktop IPC upstream authorizes against the single main window authorizes against the registry instead.
The preload policy accepts the complete desktop bridge, keeping upstream's profile-aware assembly intact.
Entry points are hub project actions, the command palette, a keybinding, and renderer IPC, all gated on `window.desktopBridge.openProjectWindow`.

#### Sidebar scope

Physical sidebar policy lives in `apps/web/src/components/sidebar/SidebarPhysicalScope.ts`.
Both renderers delegate exact environment and project filtering to it, and the modern sidebar passes its groups and logical selection into the same adapter.
Missing project metadata keeps the physical key instead of opening the all-project scope.
The caller owns selection storage and its setter, so a tagged replay keeps upstream persistence.
Grouping, search, menus, manual order, and navigation stay in their existing derivation points.

The scope reaches the renderers ambiently through `apps/web/src/components/sidebar/SidebarPhysicalScopeContext.tsx`.
The project route provides it and each sidebar reads it, so `AppSidebarLayout`, `Sidebar`, and `LegacySidebar` keep their exact upstream declarations.
Carrying the ref as a prop meant re-declaring all three every time upstream touched that render tree.
No provider means the hub, so the web client is unchanged without a project window.
The `sidebar-physical-scope` guard rejects direct physical matching added back to either renderer while permitting the adapter calls.

#### Scoped lists and QoL

QoL covers a retry when a scoped draft fails to start, the `dev:desktop:agent` launcher, route test naming, and list scope.
The shared resolver and toggle live in `apps/web/src/windowProjectScope.ts` and `WindowProjectScopeToggle.tsx`.
`PullRequestProjectScope.ts` adapts the upstream Pull Requests page through narrow scope and filter calls, and the project route reuses the hub page component and search validator.
Scoped PR and Issues readiness lives in `apps/web/src/state/windowProjectBootstrap.fork.ts`, which observes only the named environment while `state/shell.ts` keeps upstream's all-environment loop.
The adopted `pull-request-project-scope` guard rejects inline route policy, nullable-project picker policy, the retired duplicate search module, and scoped bootstrap declarations in upstream shell state.
Narrow adapter calls, upstream option derivation, and the hub validator stay the integration points during original-patch repair.
Two bugfixes reproduce on an unmodified upstream build and are retire candidates; the rest are fork-only.
The eager Lucide development-load guard tracks pending `pingdotgg/t3code#9943` at head `307b29ec`; retire it once a tag carries equivalent optimizer configuration and coverage.

#### Update relaunch

`quitAndInstall` destroys every window and returns with no arguments, which is correct upstream where one window exists.
Here it collapses a workspace-per-project layout into a single hub window.
`apps/desktop/src/window/DesktopWindowSession.ts` writes a one-shot manifest just before the install tears the windows down, and the next launch consumes it before `openArguments`, so an explicit intent still wins.
`apps/desktop/src/window/hyprland.ts` reads each window's workspace over the compositor socket and moves the restored window back silently.
Neither decides where a window belongs, so `AGENTS.md`'s rule against encoding compositor policy holds.
Off Hyprland every operation is a no-op.

#### Dev app launcher

**`dev:app`** is development-only operator tooling, not shipped window policy.
It creates one retained editable fixture project and launches external web, native preview, or Electron against checkout-local state.

| Concern     | Behavior                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Workspace   | takes `+1`, `-1`, a positive absolute id, or `none`, resolving relative placement once                                      |
| Environment | drops the invoking app's dev-runner environment before loading repository configuration                                     |
| Profile     | development Electron gets a checkout-local `.t3/electron` profile; packaged launches keep upstream resolution               |
| Placement   | stages exact-title map and activation-suppression rules, uses `showInactive`, verifies, then neutralizes the temporary rule |
| Compositor  | keeps legacy keyword rules, and uses named Lua rule handles only on a Lua-capable compositor                                |
| Isolation   | concurrent worktrees get separate homes, profiles, titles, records, process groups, ports, and output                       |

The desktop development graph refreshes the server bundle in place and runs no web client build, so `apps/web/dist` and `apps/server/dist/client` stay byte-identical for other clients.

#### Project identity

Every provider subprocess receives `T3CODE_PROJECT_ID` and `T3CODE_THREAD_ID`.
A project window starts with its project id as the window title, which Hyprland keeps as `initialTitle`.
Tooling an agent runs inside a project window can therefore find its own window without guessing from `cwd`.
`ProviderSessionStartInput.projectId` carries the id, and the binding persists it across a restart.

### Retirement condition

Delete this domain when either holds.

| Condition                                                                                      |
| ---------------------------------------------------------------------------------------------- |
| Browser mode reaches practical Electron parity, including terminals and nested browser windows |
| Upstream ships its own multi-window or project-scoped window support                           |

The first is the likely one.
`previewBridge.ts` returning something other than `null` on web is one signal to re-open the question.
Verify the complete browser and Electron gap before retiring.

### Rebase scan

The named preview guard is `preserves profile partitions and window ownership through the assembled preload` in `apps/desktop/src/ipc/methods/preview.fork.test.ts`.
It exercises the real preload, IPC validation, WindowPolicy, PreviewManager, and BrowserSession over isolated Electron storage.
Profile clearing must preserve other profiles, and equal hub and project tab IDs must stay independent.

| Path                                                                                                                                | Why it matters                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/desktop/src/window/DesktopWindow.ts`                                                                                          | Window service the fork makes plural; no-focus dev launch seam.                       |
| `apps/desktop/src/app/DesktopConfig.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`, `apps/desktop/src/app/DesktopAppIdentity.ts` | Development-only placement and checkout-local profile overrides.                      |
| `package.json`, `t3.json`, `scripts/dev-app*.ts`, `scripts/lib/dev-app*.ts`                                                         | Expose and guard the shared isolated development launcher.                            |
| `scripts/dev-desktop-agent.ts`, `scripts/lib/dev-desktop-agent.ts`                                                                  | Worktree CDP endpoint and explicit launch workspace.                                  |
| `.agents/skills/test-t3-app/**`, `docs/fork/internals/scripts.md`                                                                   | Agent testing guidance for the launcher and fixture.                                  |
| `apps/desktop/src/window/WindowIdentity.ts`                                                                                         | Fork-only. A conflict means upstream added an identity model.                         |
| `apps/desktop/src/window/DesktopWindowSession.ts`                                                                                   | Fork-only. Manifest carrying windows across an update.                                |
| `apps/desktop/src/window/hyprland.ts`                                                                                               | Fork-only. The only compositor client.                                                |
| `apps/desktop/src/backend/DesktopBackendPool.test.ts`                                                                               | Shared backend pool lifecycle.                                                        |
| `apps/desktop/src/updates/DesktopUpdates.ts`                                                                                        | Captures the session before `destroyAll`; upstream edits it.                          |
| `apps/server/src/provider/providerSessionEnvironment.ts`                                                                            | `T3CODE_PROJECT_ID` and `T3CODE_THREAD_ID`.                                           |
| `apps/server/src/provider/Layers/*Adapter.ts`                                                                                       | Every adapter passes that identity into its runtime.                                  |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`                                                                              | Project identity propagation through Codex.                                           |
| `apps/server/src/provider/Layers/ProviderService.ts`                                                                                | Project-scoped provider session startup.                                              |
| `apps/server/src/provider/Layers/ProviderService.test.ts`                                                                           | Covers that startup.                                                                  |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`                                                                    | Carries `projectId` on session start input.                                           |
| `apps/server/src/keybindings.test.ts`                                                                                               | Project-window keybinding dispatch.                                                   |
| `apps/desktop/src/app/DesktopClerk.ts`                                                                                              | Single-instance lock and deep-link forwarding.                                        |
| `apps/desktop/src/preview/Manager.ts`                                                                                               | Upstream preview delegates through the fork boundary.                                 |
| `apps/desktop/src/preview/Manager.test.ts`                                                                                          | Shared native preview behind that boundary.                                           |
| `apps/desktop/src/preview/WindowPolicy*.ts`                                                                                         | Fork-owned ownership, authorization, and bridge capability.                           |
| `apps/desktop/src/preview/WindowPolicy.fork.test.ts`                                                                                | Routing, authorization, disposal, project-window capabilities.                        |
| `apps/desktop/src/preview/Manager.fork.test.ts`                                                                                     | Real manager tab namespacing and cross-window denial.                                 |
| `apps/desktop/src/ipc/methods/preview.fork.test.ts`                                                                                 | Preload profile clearing and independent tab ownership.                               |
| `apps/desktop/src/ipc/**`, `apps/desktop/src/preload.ts`                                                                            | Narrow preview-policy integrations; bridge literal stays upstream-shaped.             |
| `apps/desktop/src/ipc/methods/snapShot.ts`                                                                                          | Fork widens main-window authorization to the registry.                                |
| `apps/desktop/src/ipc/methods/snapShotSender.fork.ts`, `apps/desktop/src/ipc/methods/snapShot.fork.test.ts`                         | Fork-only registry-backed sender resolution and its proof.                            |
| `packages/contracts/src/ipc.ts`                                                                                                     | `openProjectWindow` lives here.                                                       |
| `apps/web/src/routes/project.*`                                                                                                     | Fork-only route subtree.                                                              |
| `apps/web/src/routes/__root.tsx`                                                                                                    | Mounts the scoped project shell at the root.                                          |
| `apps/web/src/routes/project.$environmentId.$projectId.pull-requests.tsx`                                                           | Keeps Pull Requests inside the scoped shell.                                          |
| `apps/web/src/desktopProjectWindows.ts`                                                                                             | Bridge detection, scoped window ref, brand target.                                    |
| `apps/web/src/windowProjectScope.ts`                                                                                                | Shared list-scope resolver and storage key.                                           |
| `apps/web/src/components/WindowProjectScopeToggle.tsx`                                                                              | Shared project and all-project segmented control.                                     |
| `apps/web/src/components/pullRequest/PullRequestProjectScope.ts`                                                                    | Fork-owned physical scope policy and route adapter.                                   |
| `apps/web/src/components/pullRequest/PullRequestProjectScope.fork.test.ts`                                                          | Physical, all-project, remote, and search-patch scope.                                |
| `apps/web/src/components/pullRequest/pullRequestProjectFilter.logic.ts`                                                             | Upstream filter-choice derivation the fork calls.                                     |
| `apps/web/src/components/pullRequest/pullRequestProjectFilter.logic.test.ts`                                                        | Upstream coverage for that derivation.                                                |
| `apps/web/src/components/pullRequest/PullRequestsUnavailableState.tsx`                                                              | Upstream error presentation and refresh affordance.                                   |
| `apps/web/src/components/ui/menu.tsx`                                                                                               | Upstream radio-item indicator the filter menu renders.                                |
| `apps/web/src/components/ui/refresh-icon.tsx`, `apps/web/src/components/ui/spinner.tsx`, `apps/web/src/lib/visibleAnimation.ts`     | Upstream loading and refresh feedback.                                                |
| `apps/web/src/lib/visibleAnimation.test.ts`                                                                                         | Upstream coverage for visibility-gated animation.                                     |
| `apps/web/src/index.css`                                                                                                            | Upstream animation utilities those indicators consume.                                |
| `apps/web/src/state/pullRequests.ts`                                                                                                | Upstream merged-list refresh override.                                                |
| `apps/web/src/state/windowProjectBootstrap.fork.ts`, `apps/web/src/state/windowProjectBootstrap.fork.test.ts`                       | Scoped readiness for PRs and Issues, with retry transitions.                          |
| `apps/web/src/state/shell.ts`                                                                                                       | Retains upstream all-environment bootstrap ownership.                                 |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                                                                                 | Pull Requests and brand navigation in the active scope.                               |
| `apps/web/src/components/ChatView.tsx`                                                                                              | Window navigation and dev-action handoff; retain cancellation before terminal writes. |
| `apps/web/src/browser/devAppPreviewHandoff.ts` and `devAppPreviewHandoff.fork.test.ts`                                              | Local-environment guard and streamed readiness; cold builds outlive the timeout.      |
| `apps/web/vite.config.ts`                                                                                                           | Lucide optimization exclusion; retire with the upstream fix.                          |
| `apps/web/src/lucideOptimizer.test.ts`                                                                                              | Real optimization guard; retire with its Vite hunk.                                   |
| `apps/web/src/components/settings/ProjectSettingsPanel.tsx`                                                                         | Project settings reached from scoped chrome.                                          |
| `apps/web/src/components/settings/KeybindingsSettings.tsx`                                                                          | Gates project-window keybinding visibility.                                           |
| `apps/web/src/hooks/useThreadActions.ts`                                                                                            | Thread actions retain the active window scope.                                        |
| `apps/web/src/components/Sidebar.logic.ts`                                                                                          | Compatibility export delegates to the fork adapter.                                   |
| `apps/web/src/components/Sidebar.logic.test.ts`                                                                                     | Fixture exports stay available to fork-owned tests.                                   |
| `apps/web/src/components/sidebar/SidebarPhysicalScope.ts`                                                                           | Fork-owned exact scope adapter; caller-owned logical state.                           |
| `apps/web/src/components/sidebar/SidebarPhysicalScope.fork.test.ts`                                                                 | Scope, missing metadata, search, grouping, setter, ordering.                          |
| `apps/web/src/components/sidebar/SidebarPhysicalScopeContext.tsx`                                                                   | Fork-owned ambient scope; upstream declarations untouched.                            |
| `apps/web/src/routes/project.$environmentId.$projectId.tsx`                                                                         | Fork-owned project route providing the physical scope.                                |
| `apps/web/src/components/Sidebar.tsx`                                                                                               | Applies the active scope to the shared sidebar.                                       |
| `apps/web/src/components/LegacySidebar.tsx`                                                                                         | Keeps project scope in the legacy sidebar.                                            |
| `apps/web/src/composerDraftStore.ts`                                                                                                | Persists drafts within window thread scope.                                           |
| `apps/web/src/composerDraftStore.test.ts`                                                                                           | Covers project-scoped draft restoration.                                              |
| `apps/web/src/hooks/useHandleNewThread.ts`                                                                                          | Starts new threads inside the active window.                                          |
| `docs/user/thread-sidebar.md`                                                                                                       | Documents the scoped sidebar; upstream also edits it.                                 |
| `docs/user/keybindings.md`                                                                                                          | Documents project-window keyboard entry points.                                       |
| `apps/web/src/routeTree.gen.ts`                                                                                                     | Generated. Regenerate rather than resolving by hand.                                  |
| `apps/web/src/components/preview/previewBridge.ts`                                                                                  | The retirement signal. Read it on every rebase.                                       |
| `apps/web/src/components/CommandPalette.tsx`                                                                                        | Entry point, and a busy upstream file.                                                |
| `apps/web/src/components/ChatMarkdown.tsx`                                                                                          | Shared with `github-issues`; neither domain owns it.                                  |
| `packages/contracts/src/keybindings.ts`                                                                                             | Defines the project-window keybinding action.                                         |
| `packages/shared/src/keybindings.ts`                                                                                                | Maps that action across clients.                                                      |
| `apps/desktop/src/app/DesktopApp.ts`                                                                                                | Routes a launch intent to the owning window.                                          |
| `apps/desktop/src/app/DesktopLifecycle.test.ts`                                                                                     | Registration, intent routing, post-update restore.                                    |
| `apps/desktop/src/main.ts`                                                                                                          | Consumes the restore manifest before `openArguments`.                                 |
| `apps/desktop/src/updates/DesktopUpdates.test.ts`                                                                                   | Session capture surviving `quitAndInstall`.                                           |
| `apps/desktop/src/window/DesktopApplicationMenu.test.ts`                                                                            | Menu entries that open a project window.                                              |
| `apps/desktop/src/window/DesktopWindow.test.ts`                                                                                     | Plural windows, preview namespacing, dev launch seam.                                 |
| `apps/web/src/components/AppSidebarLayout.tsx`                                                                                      | Carries the physical project sidebar scope.                                           |
| `apps/web/src/components/pullRequest/PullRequestListFilters.tsx`                                                                    | Narrow visibility flag delegates scope to the adapter.                                |
| `apps/web/src/components/pullRequest/PullRequestListFilters.fork.test.tsx`                                                          | Guards the scoped picker seam outside the upstream test.                              |
| `apps/web/src/routes/_chat.draft.$draftId.tsx`                                                                                      | Hub draft route keeping the project routes reachable.                                 |
| `apps/web/src/routes/_chat.pull-requests.tsx`                                                                                       | Hub twin of the scoped Pull Requests route.                                           |
| `packages/contracts/src/provider.ts`                                                                                                | Carries `projectId` on provider session start.                                        |
| `package.json`                                                                                                                      | Holds the `dev:desktop:agent` launcher script.                                        |
| `docs/fork/internals/scripts.md`                                                                                                    | Documents that launcher.                                                              |
| `apps/desktop/src/electron/ElectronWindow.ts`                                                                                       | Keyed by `WindowIdentity` so an update restores each workspace.                       |
| `apps/web/src/routes/_chat.index.tsx`                                                                                               | Shared `DraftStartError` retry for both draft routes.                                 |
| `apps/web/src/routes/settings.tsx`                                                                                                  | `useLeaveFullPage` closes Settings back into the window.                              |
| `apps/server/vite.config.ts`                                                                                                        | Adds the `dev:bundle` task the isolated launch builds through.                        |
| `apps/server/package.json`                                                                                                          | Holds the `build:bundle:dev` script that task invokes.                                |
| `.agents/skills/test-t3-mobile/SKILL.md`                                                                                            | Reuse a `dev:app` backend and port instead of a second one.                           |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`                                                                                   | `T3CODE_DESKTOP_DEVTOOLS` opting out of automatic devtools.                           |

## browser-bookmarks

### Need

Durable embedded-browser shortcuts, scoped per project and per T3 Code profile.

### Shape

The web client persists a profile-global collection and project-keyed collections in local storage.
A Chrome-style star in the address field saves, moves, or removes the current page.
New browser tabs show non-empty Project and Global sections before recent pages and local servers.
The store normalizes URLs before deduplication, caps collection and project counts, and listens for storage changes.
Open project windows converge without a server contract or desktop IPC surface.

### Retirement condition

Delete this domain when upstream ships durable browser bookmarks with both project and profile-global scopes, equivalent address-field controls, and cross-window consistency.

### Rebase scan

| Path                                                           | Why it matters                                 |
| -------------------------------------------------------------- | ---------------------------------------------- |
| `apps/web/src/browserBookmarkStore.ts`                         | Fork-only persistence and scope model.         |
| `apps/web/src/browserBookmarkStore.test.ts`                    | Storage, migration, isolation, scope movement. |
| `apps/web/src/browserHistoryStore.ts`                          | Supplies the normalized project identity.      |
| `apps/web/src/components/preview/PreviewBookmarkCard.tsx`      | Fork-only bookmark row.                        |
| `apps/web/src/components/preview/PreviewBookmarkMenu.tsx`      | Fork-only star and scope menu.                 |
| `apps/web/src/components/preview/PreviewBookmarkMenu.test.tsx` | Menu interaction and accessibility.            |
| `apps/web/src/components/preview/PreviewChromeRow.tsx`         | Shared chrome where the star is mounted.       |
| `apps/web/src/components/preview/PreviewEmptyState.tsx`        | Shared new-tab page rendering the sections.    |
| `apps/web/src/components/preview/PreviewEmptyState.test.tsx`   | New-tab ordering and empty sections.           |
| `apps/web/src/components/preview/PreviewView.tsx`              | Browser orchestration and cross-window sync.   |
| `docs/fork/user/browser.md`                                    | Fork-only user documentation.                  |
| `README.md`, `docs/README.md`                                  | Shared indexes linking the browser guide.      |
| `apps/web/src/components/preview/PreviewView.test.tsx`         | Bookmarking beside upstream preview behaviour. |

## github-issues

### Need

Browse GitHub issues and hand one to an agent on web and desktop, with project-window scope.

### Shape

Contracts and server expose read-only issue list and detail requests through the existing GitHub CLI integration.
Lists degrade per project, merge capable environments, and keep environment identity on every client-side reference.

The web renderer provides hub and project-window routes with search, state and project filters, descriptions and comments, in-app link claiming, right-panel tabs, and an unsent "Work on this issue" hand-off to a fresh composer.
The hand-off prompt is an environment-scoped template under Source Control settings.
The palette has a "Go to Issues" command and deliberately no "Go to Pull Requests" twin.

`githubIssueSettingsSearch.ts` registers the handoff search item through `useAvailableSettingsSearchItems`, after upstream availability filtering.
The adopted `github-issue-settings-search` guard rejects adding that item back into the upstream registry.
Keep the extension's ordering, fallback, and deduplication when repairing the original registry patch.

### Retirement condition

Delete the service and UI when upstream ships a stable GitHub Issues list, detail, and agent hand-off across web and desktop with multi-environment scoping.
If upstream ships only the core service, retire this domain's service and UI while keeping the project-window scope adapter under `project-windows`.

### Rebase scan

| Path                                                                               | Why it matters                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/contracts/src/githubIssue.ts`                                            | Wire issue shapes and tagged failures.               |
| `packages/contracts/src/settings.ts`                                               | Environment-scoped hand-off prompt template.         |
| `packages/contracts/src/rpc.ts`, `packages/contracts/src/environment.ts`           | RPC registration and optional capability.            |
| `apps/server/src/githubIssue/**`                                                   | CLI normalization, discovery, list, detail service.  |
| `apps/server/src/sourceControl/GitHubCli.ts`                                       | Shared process boundary for excluded CLI changes.    |
| `apps/server/src/ws.ts`, `apps/server/src/server.ts`                               | Handler and server-lifetime service wiring.          |
| `apps/server/src/auth/RpcAuthorization.ts`                                         | Read-only authorization scopes.                      |
| `apps/server/src/environment/ServerEnvironment.ts`                                 | Static capability advertisement.                     |
| `apps/server/src/environment/ServerEnvironment.test.ts`                            | Covers that advertisement.                           |
| `packages/contracts/src/environment.test.ts`                                       | Covers the optional capability.                      |
| `packages/client-runtime/src/state/githubIssues.ts`                                | Client-neutral atoms and multi-environment identity. |
| `packages/client-runtime/package.json`                                             | Client state package dependencies.                   |
| `apps/web/src/routes/_chat.issues.tsx`                                             | Hub list and shared page implementation.             |
| `apps/web/src/routes/project.$environmentId.$projectId.issues.tsx`                 | Project-scoped route wrapper.                        |
| `apps/web/src/components/githubIssue/githubIssueRouteSearch.ts`                    | Shared route search contract.                        |
| `apps/web/src/components/githubIssue/GitHubIssueDetailPanel.tsx`                   | Detail rendering and configurable hand-off.          |
| `apps/web/src/components/settings/GitHubIssueSettings.tsx`                         | Source Control setting and fork-owned search anchor. |
| `apps/web/src/components/settings/githubIssueSettingsSearch.ts`                    | Fork-owned hand-off search registration.             |
| `apps/web/src/components/settings/githubIssueSettingsSearch.fork.test.ts`          | Guards registry order and hand-off search.           |
| `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts`              | Attaches the fork search item.                       |
| `apps/web/src/rightPanelStore.ts`, `apps/web/src/components/RightPanelTabs.tsx`    | Persisted issue surfaces and tabs.                   |
| `apps/web/src/rightPanelStore.test.ts`                                             | Covers the persisted Issues selection.               |
| `apps/web/src/components/RightPanelTabs.test.tsx`                                  | Covers the Issues launcher tab.                      |
| `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatMarkdown.tsx` | Detail rendering and link interception.              |
| `apps/web/src/lib/openPullRequestLink.ts`                                          | Workspace issue URL claiming.                        |
| `apps/web/src/lib/openPullRequestLink.test.ts`                                     | Covers claiming beside pull requests.                |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                                | Scoped sidebar entry point.                          |
| `apps/web/src/components/CommandPalette.tsx`                                       | Scoped command-palette entry point.                  |
| `docs/user/source-control.md`                                                      | Documents browsing and hand-off.                     |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`                          | Covers the GitHub link destination setting.          |
| `apps/server/src/pullRequest/PullRequestService.ts`                                | Serves the data this surface reads.                  |
| `apps/server/src/pullRequest/PullRequestService.test.ts`                           | Link destinations and description media upload.      |
| `apps/web/src/components/ChatMarkdown.test.tsx`                                    | GitHub link rendering in chat.                       |
| `apps/web/src/components/CommandPalette.logic.ts`                                  | Adds the Issues entry point.                         |
| `apps/web/src/components/CommandPalette.logic.test.ts`                             | Covers that entry point.                             |
| `apps/web/src/components/settings/SourceControlSettings.tsx`                       | Hosts the configurable handoff prompt.               |
| `apps/web/src/components/settings/settingsSearch.ts`                               | Indexes the link destination settings.               |
| `apps/web/src/routes/_chat.pull-requests.tsx`                                      | Hub route the Issues surface sits beside.            |
| `apps/web/src/state/pullRequests.ts`                                               | Client state shared with pull requests.              |
| `packages/contracts/src/index.ts`                                                  | Exports the issues contracts.                        |
| `packages/contracts/src/settings.test.ts`                                          | Covers the settings this domain adds.                |
| `apps/web/src/routeTree.gen.ts`                                                    | Generated tree carrying both routes; regenerate it.  |

## custom-agents

### Need

Choose a provider-native custom agent as the main Claude or Codex thread.
Upstream exposes model options but no main-thread custom-agent control.

### Shape

Provider model capabilities carry an `agent` select descriptor.
The web composer renders it in its own picker beside the model and reasoning controls, and compact web and mobile surfaces reuse the existing provider-options menus.

| Provider | Inventory                       | Applied as                                                     |
| -------- | ------------------------------- | -------------------------------------------------------------- |
| Claude   | Agent SDK initialization result | the `--agent` launch argument                                  |
| Codex    | `<CODEX_HOME>/agents/*.toml`    | `thread/start` or `thread/resume` config and instruction layer |

Project Codex definitions override personal ones of the same name at session start.
Selections persist in `modelSelection.options` and restore with the provider binding.
Changing the root agent restarts the provider session before the next turn.

#### Boundaries

`ClaudeAgentOptions.fork.ts` owns SDK agent normalization, Claude's descriptor, and the launch-argument override.
`CodexAgentOptions.fork.ts` owns Codex's descriptor and the discovery decorator the driver composes into its snapshot pipeline.
Provider setup, `CodexDriver.ts`, and `ClaudeAdapter.ts` keep only the small discovery and result adaptation calls, so upstream initialization, auth, model, and usage changes replay independently.
`makeCodexAgentOptionsDecorator` acquires `FileSystem` and `Path` inside the sibling, so upstream's `checkProvider` keeps its `R = never` shape and concurrent `Effect.zipWith`.
The `provider-agent-boundary` guard rejects reintroducing those declarations into `ClaudeProvider.ts`, `CodexProvider.ts`, `CodexDriver.ts`, or `ClaudeAdapter.ts`.
Codex discovery stays in `CodexAgents.ts`, and neither helper shares provider policy.

Child activity redaction, truncation, and the changed-file shape stay in `childItemRenderDetail.ts`, while `ClaudeChildItemDetail.fork.ts` maps Claude's tool vocabulary onto it.
Session identity stays in `providerSessionEnvironment.ts`, and launcher scrubbing stays in the existing environment helpers.
Keep the small provider-service identity persistence and reactor agent-change joins: extracting them would duplicate their upstream owners.

#### Agents panel

The panel folds provider-native Codex and Claude child work into one roster.
Selecting a child opens a read-only detail surface backed by authenticated, paginated activity history and the live thread stream.
Provider-owned child identity stays server-side, and an unsupported provider reports detail as unavailable instead of presenting an inert row.
Timeline spawn CTAs keep upstream markup, while `AgentSpawnNavigation.ts` owns direct-child versus fleet-roster selection.
The adopted `agent-spawn-navigation` guard rejects direct target-resolution imports and the old inline selection closure in `MessagesTimeline.tsx`, while allowing the handler, widened callback arguments, and upstream CTA markup.

### Retirement condition

Delete this domain when upstream can discover and select provider-native main-thread agents for Claude and Codex.
The upstream behavior must persist the selection and apply it on new and resumed sessions.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                             | Why it matters                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/chat/ChatComposer.tsx`                                                                                                                                                                                                                                                                                                  | Owns the composer control order.                                                                                            |
| `apps/web/src/components/chat/TraitsPicker.tsx`                                                                                                                                                                                                                                                                                                  | Splits root agents from model traits.                                                                                       |
| `apps/web/src/components/chat/composerProviderState.tsx`                                                                                                                                                                                                                                                                                         | Renders capability-driven composer controls.                                                                                |
| `apps/server/src/provider/Layers/ClaudeProvider.ts`                                                                                                                                                                                                                                                                                              | Discovers Claude agents.                                                                                                    |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                                                                                                                                                                                                                                                                                               | Calls the launch-argument and child-detail seams.                                                                           |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`                                                                                                                                                                                                                                                                                          | Claude agent discovery and launch behavior.                                                                                 |
| `apps/server/src/provider/Drivers/CodexAgents.ts`                                                                                                                                                                                                                                                                                                | Discovers and parses Codex agent definitions.                                                                               |
| `apps/server/src/provider/Layers/CodexAdapter.ts`                                                                                                                                                                                                                                                                                                | Applies Codex selection at the adapter boundary.                                                                            |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`                                                                                                                                                                                                                                                                                           | Codex agent selection and session behavior.                                                                                 |
| `apps/server/src/provider/Layers/CodexCollabWire.test.ts`                                                                                                                                                                                                                                                                                        | Codex custom-agent collaboration wire behavior.                                                                             |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts`                                                                                                                                                                                                                                                                                         | Layers Codex config and instructions onto a thread.                                                                         |
| `apps/server/src/provider/Layers/CodexProvider.ts`                                                                                                                                                                                                                                                                                               | Builds the Codex agent select descriptor.                                                                                   |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`                                                                                                                                                                                                          | Restarts sessions when the root agent changes.                                                                              |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts`                                                                                                                                                                                             | Stamps child-owned activity for reconstruction.                                                                             |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts`                                                                                                                                                                                                                                                                               | Custom-agent orchestration behavior.                                                                                        |
| `apps/server/src/orchestration/ActivityPayloadProjection.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`                                                                                                                                                    | Keeps snapshot and live activity projections ordered.                                                                       |
| `apps/server/src/server.test.ts`                                                                                                                                                                                                                                                                                                                 | Custom-agent behavior through server seams.                                                                                 |
| `apps/server/package.json`, `pnpm-lock.yaml`                                                                                                                                                                                                                                                                                                     | The `smol-toml` dependency the Codex parser needs.                                                                          |
| `packages/client-runtime/package.json`                                                                                                                                                                                                                                                                                                           | Client activity package dependencies.                                                                                       |
| `packages/contracts/src/model.ts`, `packages/shared/src/model.ts`                                                                                                                                                                                                                                                                                | Own the generic provider-option contract.                                                                                   |
| `docs/user/providers-codex.md`                                                                                                                                                                                                                                                                                                                   | Documents Codex custom-agent selection.                                                                                     |
| `packages/contracts/src/orchestration.ts`, `packages/contracts/src/environmentHttp.ts`                                                                                                                                                                                                                                                           | Agent selection and bounded child activity pages.                                                                           |
| `packages/client-runtime/src/state/orchestration.ts`, `packages/client-runtime/src/state/threadReducer.ts`, `packages/client-runtime/src/state/subagentRuntime.ts`, `packages/client-runtime/src/state/subagentRuntime.test.ts`, `packages/client-runtime/src/state/subagentDetail.ts`, `packages/client-runtime/src/state/agentActivityHttp.ts` | Load, sequence, and merge retained and live child activity.                                                                 |
| `apps/mobile/src/lib/threadActivity.ts`, `apps/mobile/src/lib/threadActivity.test.ts`                                                                                                                                                                                                                                                            | Snapshot order before sequenced live activity.                                                                              |
| `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/AgentsPanel.tsx`, `apps/web/src/components/AgentDetailPanel.tsx`                                                                                                                                                                                                                | Own the roster and read-only child inspector.                                                                               |
| `apps/web/src/rightPanelStore.ts`                                                                                                                                                                                                                                                                                                                | Persists thread-scoped child selection.                                                                                     |
| `apps/web/src/components/chat/MessagesTimeline.tsx`                                                                                                                                                                                                                                                                                              | Narrowly mounts fork navigation around the upstream CTA.                                                                    |
| `apps/web/src/components/chat/AgentSpawnNavigation*`                                                                                                                                                                                                                                                                                             | Fork-owned child selection and behavioral guard.                                                                            |
| `apps/web/src/rightPanelStore.test.ts`                                                                                                                                                                                                                                                                                                           | Persisted panel selection for child work.                                                                                   |
| `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts`                                                                                                                                                                                                                                                                                      | Diff detail served with child work.                                                                                         |
| `apps/server/src/orchestration/ActivityPayloadProjection.test.ts`                                                                                                                                                                                                                                                                                | Child-work activity payloads.                                                                                               |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`                                                                                                                                                                                                                                                                                | Projects child work into the snapshot.                                                                                      |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`                                                                                                                                                                                                                                                                          | Attributed child results.                                                                                                   |
| `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`                                                                                                                                                                                                                                                                              | Paginates child work.                                                                                                       |
| `apps/server/src/project/ProjectSetupScriptRunner.test.ts`                                                                                                                                                                                                                                                                                       | Setup-script markers and child-work paging.                                                                                 |
| `apps/server/src/provider/Drivers/CodexDriver.ts`                                                                                                                                                                                                                                                                                                | Composes agent discovery and per-workspace skills.                                                                          |
| `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`                                                                                                                                                                                                                                                                                | Agent capability probing.                                                                                                   |
| `apps/server/src/provider/Layers/CodexAdapter.fork.test.ts`, `apps/server/src/provider/Layers/ProviderService.fork.test.ts`, `apps/web/src/keybindings.fork.test.ts`, `apps/web/src/uiStateStore.fork.test.ts`, `apps/web/src/components/sidebar/SidebarPhysicalScope.fork.test.ts`                                                              | These siblings restate upstream shapes, wiring, helper names, and state literals, so an upstream rename breaks the sibling. |
| `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`                                                                                                                                                                                                                                                                                  | Reaping a session that owns child work.                                                                                     |
| `apps/server/src/serverRuntimeStartup.test.ts`                                                                                                                                                                                                                                                                                                   | Startup wiring for paginated child work.                                                                                    |
| `apps/web/src/components/chat/composerProviderState.test.tsx`                                                                                                                                                                                                                                                                                    | Agent selection in the composer.                                                                                            |
| `apps/web/src/connection/runtime.ts`                                                                                                                                                                                                                                                                                                             | Client runtime carrying agent and child-work state.                                                                         |
| `apps/web/src/providerModels.ts`                                                                                                                                                                                                                                                                                                                 | Lists the selectable agents per provider.                                                                                   |
| `docs/user/providers-claude.md`                                                                                                                                                                                                                                                                                                                  | Documents main-thread agent selection.                                                                                      |
| `packages/client-runtime/src/state/threadReducer.test.ts`                                                                                                                                                                                                                                                                                        | Child work in the thread reducer.                                                                                           |
| `packages/contracts/src/providerRuntime.ts`                                                                                                                                                                                                                                                                                                      | Carries child result and diff detail.                                                                                       |
| `README.md`                                                                                                                                                                                                                                                                                                                                      | The fork index links `docs/fork/user/agents.md`; upstream edits that list.                                                  |
| `apps/server/src/project/AgentSessionScanner.test.ts`                                                                                                                                                                                                                                                                                            | Upstream literal of the snapshot-query shape; only typecheck catches a missing `getAgentActivitySnapshot`.                  |

## markdown-editing

### Need

T3 Code renders Markdown previews and edits Markdown source, but has no rich editing mode.
The fork needs one surface that edits the rendered document and still saves Markdown.

### Shape

The web file preview offers Rich and Source modes for `.md` files.
Rich mode uses a lazy-loaded Milkdown editor with CommonMark, GFM, YAML frontmatter, history, and clipboard support.
It reuses the existing optimistic file cache and save coordinator, so local and remote environments share one path.
MDX stays on the rendered preview because the pipeline cannot preserve JSX safely, and truncated files stay read-only.

The adopted `rich-markdown-boundary` guard rejects editor imports and inline rich surfaces in FilePreviewPanel, and `normalizeDotSegments` implementations in the shared link resolver.
Keep the preview boundary mount and document-link adapter in their fork-owned modules.
Preview-mode, rich-editor link, and save-coordinator tests guard behavior, and the real scan CLI fixtures prove rejected additions and accepted boundary calls.
During historical repair, derive the lockfile from the accepted manifests with `vp i`; never replay the old generated dependency patch.

**Dependencies.** The manifest declares the granular `@milkdown/*` packages the boundary imports, never `@milkdown/kit` or `@milkdown/react`.
The umbrella re-exports what is already imported, and the React wrapper depends on `@milkdown/crepe`, which drags a Vue runtime and CodeMirror into a React-only app.
The binding that wrapper provided is one mount effect in `MarkdownRichEditor.tsx`.
`richMarkdownDependencies.fork.test.ts` holds the manifest to exactly the imported set, and `vp run fork:lockfile` proves the lockfile still records those specifiers.

### Retirement condition

Delete this domain when upstream ships a rich Markdown editor with safe frontmatter and MDX boundaries.
The replacement must use the existing file-save path and avoid loading its editor bundle during ordinary file browsing.

### Rebase scan

| Path                                                                                 | Why it matters                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `apps/web/src/components/files/FilePreviewPanel.tsx`                                 | Narrow mount for the fork-owned Rich/Source boundary.         |
| `apps/web/src/components/files/RichMarkdownPreviewBoundary.tsx`                      | Mode gating, lazy mount, file-save-path adapter.              |
| `apps/web/src/components/files/RichMarkdownPreviewBoundary.fork.test.ts`             | Markdown, MDX, host-file, reveal, truncation modes.           |
| `apps/web/src/components/files/MarkdownRichEditor.tsx`                               | Fork-only Milkdown lifecycle and change publisher.            |
| `apps/web/src/components/files/markdownPipeline.ts`, `markdownPipeline.test.ts`      | Syntax, serialization, round-trip coverage.                   |
| `apps/web/src/components/files/markdownEditorPresentation.ts`                        | Task, link, code-block, and syntax presentation.              |
| `apps/web/src/components/files/richMarkdownEditorLinks.ts`                           | Normalizes document-relative links after the shared resolver. |
| `apps/web/src/components/files/richMarkdownEditorLinks.fork.test.ts`                 | Contained, escaping, Windows, and external links.             |
| `apps/web/src/components/files/markdownFrontmatter.ts`, `markdownSerializerFixes.ts` | Frontmatter and list round-trip support.                      |
| `apps/web/src/components/files/markdown-rich-editor.css`                             | Fork-only rich editor presentation.                           |
| `apps/web/src/components/files/richMarkdownDependencies.fork.test.ts`                | Holds the Milkdown manifest to the imported set.              |
| `apps/web/package.json`                                                              | Accepted granular Milkdown and round-trip manifests.          |
| `pnpm-lock.yaml`                                                                     | Generated by the lockfile policy, never merged.               |
| `apps/web/src/components/ChatMarkdown.tsx`                                           | Upstream preview changes may replace this domain.             |
| `docs/README.md`                                                                     | Indexes the fork's Markdown editing documentation.            |

## fork-meta

### Need

The fork's own documentation, conventions, and tooling.
The domain exists so documentation and tooling commits are not mis-filed under a product domain.

### Shape

| Item                                                                                              | Role                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `README.md`, `AGENTS.md`, `docs/README.md`                                                        | The fork sections                                    |
| This document, [Fork development](./fork-development.md), [Fork sync](../operations/fork-sync.md) | Fork documentation                                   |
| `scripts/fork-*.ts` and their `fork:*` aliases                                                    | The fork gates; [Scripts](./scripts.md) indexes them |
| [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill                                   | Bot-first sync, unblock, and stable-cut procedure    |
| `.github/workflows/hyprws-upstream-sync.yml`                                                      | The bot lane and its fork-local issue upserts        |
| `.github/pull_request_template.md` trailer block                                                  | Domain list held equal to `FORK_DOMAINS`             |
| `scripts/lib/fork-progress.ts`, `scripts/lib/fork-test-quiet.ts`                                  | Shared gate progress reporter and its test silencer  |

Every fork workflow checkout stays off `persist-credentials: false`, pinned by `scripts/fork-workflow-checkout.test.ts`.

### Retirement condition

Retired with the fork.

### Rebase scan

| Path                                                                                                                                                                                   | Why it matters                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `README.md`, `AGENTS.md`, `docs/README.md`                                                                                                                                             | Upstream edits these often; they carry fork-only sections.                          |
| `package.json` scripts block                                                                                                                                                           | The `fork:*` aliases sit between upstream aliases.                                  |
| `docs/fork/internals/scripts.md`                                                                                                                                                       | Carries the `fork:*` script entries.                                                |
| `docs/internals/ci.md`                                                                                                                                                                 | Documents fork CI and advisory scan behavior.                                       |
| `docs/internals/glossary.md`                                                                                                                                                           | Carries fork-sync glossary terms.                                                   |
| `scripts/*.ts` siblings                                                                                                                                                                | The ledger script copies their Effect CLI shape.                                    |
| `scripts/fork-auto-rebase.ts`, `scripts/lib/fork-rebase-*.ts`                                                                                                                          | Bot ref safety, replay checks, issue payloads, clean-tag selection.                 |
| `scripts/lib/fork-churn-compose.ts`                                                                                                                                                    | Fork-only seam bundle producer; a conflict means upstream grew one.                 |
| `.github/workflows/hyprws-upstream-sync.yml`                                                                                                                                           | Bot mode, runner setup, fork-local issue upserts.                                   |
| `.github/pull_request_template.md`                                                                                                                                                     | Trailer block every squash body needs; its domain list may not drift.               |
| `packages/contracts/src/settings.test.ts`, `apps/web/src/components/ChatView.logic.test.ts`, `apps/web/src/components/Sidebar.logic.test.ts`                                           | Fork cases live in `*.fork.test.ts` siblings, so these take upstream edits cleanly. |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`, `apps/server/src/pullRequest/PullRequestService.test.ts`, `apps/server/src/orchestration/decider.projectThreadEnvMode.test.ts` | The fork only appends here; a changed upstream assertion is refused.                |
| `apps/web/src/components/RightPanelTabs.test.tsx`, `apps/web/src/keybindings.test.ts`, `apps/web/src/rightPanelStore.test.ts`                                                          | Same append-only rule against the `*.fork.test.*` siblings.                         |
| `apps/server/src/serverRuntimeStartup.ts`                                                                                                                                              | Reconciles legacy generated worktree setup commands.                                |
| `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`                                                                                                                      | Sibling migration keeps probe coverage out of the upstream file.                    |
| `pnpm-lock.yaml`                                                                                                                                                                       | Upstream regenerates it constantly; commits here only undo install drift.           |
| `docs/operations/release.md`                                                                                                                                                           | Documents the base and delta revision stamped into releases.                        |
| `docs/user/source-control.md`                                                                                                                                                          | Carries a rewritten link into `docs/fork/user/`; upstream edits it.                 |
| `apps/server/src/project/RepositoryIdentityResolver.test.ts`, `apps/web/src/localApi.test.ts`                                                                                          | Fork cases live in siblings; these take upstream edits cleanly.                     |
| `apps/desktop/src/preview/Manager.test.ts`                                                                                                                                             | Selected-target ownership keeps fork preview cases out.                             |
| `apps/desktop/src/updates/DesktopUpdates.test.ts`                                                                                                                                      | Retains the `capture` step before `quitAndInstall`.                                 |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`                                                                                                                 | Retains `checkoutMove: null` in upstream fixtures.                                  |
| `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`                                                                                                                         | Retains the explicit tmux environment expectations.                                 |
| `apps/server/src/workspace/WorkspaceFileSystem.test.ts`                                                                                                                                | Retains the fork's server-settings layer in the harness.                            |
| `apps/web/src/uiStateStore.test.ts`                                                                                                                                                    | Retains manual sidebar ordering cases.                                              |
| `packages/client-runtime/src/state/threadReducer.test.ts`                                                                                                                              | Retains the snapshot-prefix repair expectation.                                     |
| `apps/server/src/pullRequest/GitHubPullRequestCli.ts`                                                                                                                                  | Repairs un-export a constant and move the error to `Schema.TaggedError`.            |
| `apps/server/src/workspace/WorkspaceEntries.test.ts`                                                                                                                                   | The sibling migration deleted a case upstream keeps adding beside.                  |
| `apps/web/src/components/CommandPalette.tsx`                                                                                                                                           | The repaired `buildThreadRouteParams` import line is the conflict.                  |
| `apps/web/src/components/Sidebar.tsx`                                                                                                                                                  | Same import repair in upstream's busiest file.                                      |
| `apps/web/src/routes/_chat.pull-requests.tsx`                                                                                                                                          | Repairs reshape `PullRequestsSearch` and this route each rebase.                    |
| `apps/web/src/routes/__root.tsx`                                                                                                                                                       | Conflicts resolve to the `project-windows` shape, not upstream's.                   |
| `third-party-licenses.config.json`                                                                                                                                                     | Generated notice for the fork's `format` dependency.                                |
| `apps/desktop/src/preview/Manager.ts`                                                                                                                                                  | Repairs rework overlapping pick sessions and the error type.                        |
| `apps/server/package.json`                                                                                                                                                             | A repair shortens `build:bundle:dev` to `vp pack --no-clean`.                       |
| `apps/server/src/provider/Layers/CodexAdapter.ts`                                                                                                                                      | Repairs re-attach fork-hook markers and `.fork.ts` swaps.                           |
| `apps/server/src/provider/Layers/ProviderService.test.ts`                                                                                                                              | Keeps the `getAgentActivitySnapshot` stub the file needs.                           |
| `apps/server/src/usage/UsageService.ts`                                                                                                                                                | Re-applies the third `mergeProviderInstanceEnvironment` argument.                   |
| `apps/web/src/components/LegacySidebar.tsx`                                                                                                                                            | Folds `buildThreadRouteParams` into the thread-route import.                        |
| `docs/user/thread-sidebar.md`                                                                                                                                                          | A repair removes mode prose the fork does not ship.                                 |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`                                                                                                                                      | Sibling migration removed the dev-agent placement case.                             |
| `apps/desktop/src/app/DesktopEnvironment.ts`                                                                                                                                           | Unexports `resolveDesktopDevAgentPlacement`.                                        |
| `apps/web/src/components/Sidebar.logic.ts`                                                                                                                                             | Unexports `sidebarThreadGroupSortableId`.                                           |

## distribution

### Need

Upstream releases ship upstream code, so a fork user needs a fork build and a fork update feed.
Upstream workflows also target Blacksmith runners the fork does not have.

### Shape

| Item                                   | Role                                                             |
| -------------------------------------- | ---------------------------------------------------------------- |
| `.github/workflows/hyprws-ci.yml`      | Checks, tests, ledger, citation guard, desktop build             |
| `.github/workflows/hyprws-release.yml` | Human-cut stable releases plus a prerelease per `hyprws` landing |
| `scripts/fork-release-version.ts`      | Resolves channel metadata and the previous tag in that channel   |

Stable tags are `vX.Y.Z-hyprws.N`; nightlies are `vX.Y.Z-hyprws-nightly.YYYYMMDD.N`, with a six-hour changed-head check as fallback.
`hyprws-release.yml` omits upstream's `concurrency.queue: max` deliberately: the fork's per-landing trigger queues a build per commit, and the default single pending slot supersedes ones the newest commit already contains.
Both workflows run on GitHub-hosted runners, free for a public repository.

`scripts/build-desktop-artifact.ts` derives the update feed from `GITHUB_REPOSITORY`, so fork builds update from fork releases.
electron-updater matches a release by the tag's first semver prerelease identifier and derives the update-file name from it.
The fork's nightly tags therefore need the user-facing `nightly` channel to reach the updater as `hyprws-nightly`, with a matching `hyprws-nightly-linux.yml` asset.
`apps/desktop/src/updates/updateChannels.fork.ts` owns that mapping (RSI-Software/t3code-hyprws#762).

Upstream workflows stay in the tree untouched and disabled; editing or deleting them is a standing rebase conflict.
[Fork sync](../operations/fork-sync.md) owns the disable step.

### Retirement condition

Retired with the fork, or when upstream publishes builds the fork can ship unchanged.

### Rebase scan

| Path                                                   | Why it matters                                         |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `.github/workflows/ci.yml`                             | Copy new checks or setup steps into `hyprws-ci.yml`.   |
| `.github/workflows/release.yml`                        | Copy job-shape and Linux build changes across.         |
| `scripts/resolve-nightly-release.ts`                   | Shared next-patch helpers used by fork nightlies.      |
| `scripts/build-desktop-artifact.ts`                    | Build inputs, icon tooling, update-channel resolution. |
| `scripts/build-desktop-artifact.test.ts`               | Desktop artifact and update-channel behavior.          |
| `scripts/update-release-package-versions.ts`           | Stable and nightly version alignment.                  |
| `apps/desktop/src/updates/updateChannels.fork.ts`      | Fork-only channel mapping in one place.                |
| `apps/desktop/src/updates/DesktopUpdates.fork.test.ts` | Fork-owned proof for that mapping.                     |
| `apps/desktop/src/updates/DesktopUpdates.ts`           | One-line call site in a file upstream edits often.     |
| `apps/desktop/src/updates/updatesTestHarness.ts`       | Test-only channel recording.                           |
| `package.json` `engines` and `packageManager`          | Runner toolchain expectations.                         |
| `docs/fork/internals/scripts.md`                       | Documents the release and upstream-sync scripts.       |
| `README.md`                                            | Carries the rewritten introduction naming fork builds. |
| `apps/server/src/cloud/pinnedRuntime.ts`               | Fork tarball install path at the pinned-runtime seam.  |

## backend-attach

### Need

The developer runs `t3code-backend.service` and serves it publicly.
Upstream's desktop app always spawns its own backend, so app and service cannot both be up: the app finds `3773` busy, takes another port, and opens a second writer on the one `state.sqlite`.
The desktop app must attach to a backend it did not spawn, on the same machine and T3 home, and report one environment for it.

### Shape

| Piece                                                | Behavior                                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/app/DesktopBackendMode.ts`         | Resolves the effective mode; `managed` flips to `client-only` when a live `server-runtime.json` names a reachable server, logged on the `desktop.startup` span                      |
| `apps/desktop/src/app/DesktopRunningLocalServers.ts` | Discovers servers and mints a pairing URL through `t3 pair --json`, cross-checking environment id and origin, and rejecting a bad path, non-empty search, or token outside the hash |
| `packages/shared/src/serverRuntimeState.ts`          | Holds the runtime-state read both the server and the desktop main process need, carrying the fork's `devUrl`                                                                        |
| Client-only mode                                     | Registers no spawned primary, so the renderer has no same-origin environment                                                                                                        |
| `apps/web/src/connection/DesktopLocalAutoPair.tsx`   | Pairs once per launch, only while the saved list is empty, only in client-only mode, and only for exactly one discovered server                                                     |

A user who removes the environment on purpose is not re-paired within that session.
The fork adds neither the launch flag nor the persistent setting: both come from upstream's design and ride here unchanged.

### Retirement condition

Retire when upstream ships desktop attach.
The live upstream attempt is `pingdotgg/t3code#9376`, and this domain is an adapted subset of the `main`-based series `colonelpanic8/t3code:t3code/client-environment-suite-main`, without its environment-scoped settings half.
Retire commit by commit as upstream lands the pieces.

### Rebase scan

| Path                                                      | Why it matters                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/desktop/src/backend/DesktopBackendManager.ts`       | Upstream moves spawn lifecycle and the exit-code contract here.         |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts` | Upstream moves the packaged port here; attach reads it.                 |
| `apps/desktop/src/app/DesktopBackendMode.ts`              | Fork-owned mode resolution and its `existing-server` source.            |
| `apps/desktop/src/app/DesktopRunningLocalServers.ts`      | Discovery, the bundled pair call, the URL validator.                    |
| `apps/desktop/src/app/DesktopEnvironment.ts`              | Registers the attached environment instead of a spawned primary.        |
| `apps/desktop/src/app/DesktopLifecycle.ts`                | Skips backend startup and shutdown in client-only mode.                 |
| `apps/desktop/src/window/DesktopWindow.ts`                | Shared with `project-windows`; the only window-layer conflict.          |
| `apps/desktop/src/ipc/methods/backendMode.ts`             | Reads and writes the persisted mode over IPC.                           |
| `apps/desktop/src/ipc/methods/localServerDiscovery.ts`    | Exposes discovery and pairing to the renderer.                          |
| `apps/desktop/src/ipc/methods/window.ts`                  | Returns no local bootstrap in client-only mode.                         |
| `apps/desktop/src/settings/DesktopAppSettings.ts`         | Persists the backend mode.                                              |
| `apps/desktop/src/main.ts`                                | Parses `--backend-mode`.                                                |
| `apps/desktop/src/preload.ts`                             | Bridges discovery and pairing.                                          |
| `apps/server/src/cli/pair.ts`                             | Upstream adds `--json` and moves its state read out.                    |
| `apps/server/src/serverRuntimeState.ts`                   | The module the read moves out of; carries `devUrl`.                     |
| `packages/shared/src/serverRuntimeState.ts`               | The moved read, used by the desktop main process.                       |
| `packages/shared/package.json`                            | Its subpath export; a standing adjacent-insert conflict.                |
| `packages/contracts/src/localServerDiscovery.ts`          | Discovery and pairing wire shapes.                                      |
| `packages/contracts/src/ipc.ts`                           | Carries those IPC methods.                                              |
| `packages/contracts/src/settings.ts`                      | Carries the persisted backend mode.                                     |
| `packages/client-runtime/src/state/authHttp.ts`           | Credential exchange for a server the client did not spawn.              |
| `packages/client-runtime/src/state/auth.ts`               | Consumes it.                                                            |
| `packages/client-runtime/src/connection/presentation.ts`  | Names an attached local environment.                                    |
| `apps/web/src/connection/DesktopLocalAutoPair.tsx`        | Fork-owned; the only renderer consumer of `pairLocalServer`.            |
| `apps/web/src/environments/primary/target.ts`             | Reports client-only mode to the renderer.                               |
| `apps/web/src/environmentPresence.ts`                     | Answers whether any environment is reachable.                           |
| `apps/web/src/routes/__root.tsx`                          | Gates client-only auth state and mounts the auto-pair.                  |
| `apps/desktop/src/app/DesktopConnectionCatalogStore.ts`   | Catalog temp file uses mode `0600`; upstream edits the write path.      |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts` | Fixture and formatting alignment only; take upstream on conflict.       |
| `apps/web/src/lib/openPullRequestLink.ts`                 | Formatting pass only; take upstream on conflict.                        |
| `docs/user/source-control.md`                             | Formatting pass only; take upstream on conflict.                        |
| `apps/desktop/src/electron/ElectronProtocol.ts`           | Static protocol registration a client-only packaged launch serves from. |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`         | Repoints the packaged renderer expectation at the unpackaged path.      |
| `apps/desktop/src/app/DesktopLifecycle.test.ts`           | Adds the `handleRendererReady` stub for typecheck.                      |
| `apps/desktop/src/backend/DesktopBackendPool.test.ts`     | The same stub for the attaching pool.                                   |
| `apps/desktop/src/window/DesktopApplicationMenu.test.ts`  | The same stub for the menu's lifecycle double.                          |
| `apps/server/src/config.ts`                               | `deriveServerRuntimeStatePath` keeps dev and attach on one file.        |

## workspace-files

### Need

Agent review artifacts often live in ignored scratch directories, or in scratch shared across worktrees.
The workspace file surface must hide those paths by default while letting the operator reveal and read artifacts they deliberately created.

### Shape

| Aspect      | Rule                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Preference  | A client-local preference includes gitignored paths on demand                                              |
| Surfaces    | The file-tree toolbar and General settings expose the same preference                                      |
| Mobile      | `ignoredWorkspaceFileListing.ts` keeps device state and reveal/reset policy behind one fork-owned boundary |
| Guard       | `mobile-ignored-file-listing` rejects inline preference or request policy in the two mobile surfaces       |
| Containment | Listing ignored paths never changes ignore rules or weakens file-read containment                          |

Keep the helper call and each surface's environment and file-inspector gates during original-patch repair.

### Retirement condition

Delete this domain when upstream can reveal ignored workspace paths on demand and safely read explicitly trusted artifact links shared across worktrees.

### Rebase scan

| Path                                                                                                                                                       | Why it matters                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/server/src/workspace/WorkspaceEntries.ts`                                                                                                            | Combines the normal index with ignored VCS paths.               |
| `apps/server/src/vcs/GitVcsDriver.ts`                                                                                                                      | Lists ignored paths through Git's native rules.                 |
| `packages/contracts/src/project.ts`                                                                                                                        | Carries the optional listing request.                           |
| `packages/contracts/src/settings.ts`                                                                                                                       | Persists the client-local preference.                           |
| `apps/web/src/components/files/FileBrowserPanel.tsx`                                                                                                       | Owns the file-tree toolbar toggle.                              |
| `apps/web/src/components/settings/SettingsPanels.tsx`                                                                                                      | Owns the web and desktop settings entry point.                  |
| `apps/mobile/src/features/files/ignoredWorkspaceFileListing.ts`                                                                                            | Fork-owned mobile reveal/reset policy and listing adapter.      |
| `apps/mobile/src/features/files/ignoredWorkspaceFileListing.fork.test.ts`                                                                                  | Ordinary, ignored, reset, unresolved, host-path inputs.         |
| `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx`                                                                                                | Narrow route integration; environment selection stays upstream. |
| `apps/mobile/src/features/files/thread-file-navigator-pane.tsx`                                                                                            | Reuses the same boundary in the adaptive inspector.             |
| `apps/mobile/src/features/files/FileTreeBrowser.tsx`, `apps/mobile/src/features/files/fileTree.ts`, `apps/mobile/src/features/files/fileTree.fork.test.ts` | Preserve, present, and guard ignored state in the mobile tree.  |
| `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`                                                                                                | Exposes the preference in mobile settings.                      |
| `apps/server/src/workspace/WorkspaceFileSystem.ts`                                                                                                         | Retains containment and trusted-link read behavior.             |
| `apps/server/src/server.ts`                                                                                                                                | Provides the workspace filesystem layer.                        |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`                                                                                                  | Covers the ignored-files preference.                            |
| `apps/mobile/src/persistence/mobile-preferences.ts`                                                                                                        | Persists that preference on mobile.                             |
| `apps/web/src/components/files/projectFilesQueryState.ts`                                                                                                  | Carries the ignored-files query state.                          |
| `apps/web/src/components/settings/settingsSearch.ts`                                                                                                       | Indexes the files settings this domain adds.                    |
| `packages/contracts/src/settings.test.ts`                                                                                                                  | Covers that settings schema addition.                           |
| `README.md`                                                                                                                                                | Carries the Workspace files bullets in the feature list.        |
| `apps/server/src/workspace/WorkspaceEntries.test.ts`                                                                                                       | Wires `VcsDriverRegistry` into the harness; the reapply point.  |
| `apps/server/src/orchestration/decider.ts`                                                                                                                 | Carries the `decider-thread-env-mode-wire` fork-hook marker.    |

## thread-ordering

### Need

Operators need related active threads kept together in named groups, and a way back to automatic order after a manual drag.
Upstream persists per-thread active order under `activeOrderKey` but has no group concept, and nothing clears that key except settling the thread.

### Shape

| Aspect       | Rule                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Grouping     | A center drop on another active thread creates or extends a group; an edge drop falls through to upstream's reorder              |
| Storage      | Membership, names, and collapsed state are client-local over `activeOrderKey`; the fork stores no order of its own               |
| Removal      | Dragging outside a group removes the member, and a one-member group dissolves                                                    |
| Collapsed    | A collapsed group holds one slot: its header replaces the anchor row                                                             |
| Names        | Initial and regenerated names use the server's thread-title generation; headers also rename inline and dissolve                  |
| Scope        | Active, unpinned threads in the same physical project only                                                                       |
| Order marker | A compact marker below the project filter offers the return to automatic order; not implemented (RSI-Software/t3code-hyprws#907) |

### Retirement condition

Delete this domain when an upstream release provides named thread groups with persistent membership and a control that returns active threads to automatic order.

The fork's own manual ordering was retired at `v0.0.41-nightly.20260908.1414`; see the three `thread-ordering` rows in [Retired](#retired).
What remains is grouping plus the order-mode control, both built on `activeOrderKey`.

### Rebase scan

| Path                                                        | Why it matters                                        |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `apps/web/src/components/Sidebar.logic.ts`                  | Builds the group layout over upstream's active order. |
| `apps/web/src/components/Sidebar.logic.test.ts`             | Grouping beside upstream ordering.                    |
| `apps/web/src/components/Sidebar.logic.fork.test.ts`        | Fork-owned grouping cases.                            |
| `apps/web/src/components/Sidebar.tsx`                       | Group drag interaction and the header row.            |
| `apps/web/src/components/SidebarThreadGroup.tsx`            | Renders group headers and name controls.              |
| `apps/web/src/components/SidebarRenameInput.tsx`            | Inline group rename input.                            |
| `apps/web/src/state/threadGroups.ts`                        | Web group state.                                      |
| `apps/web/src/uiStateStore.ts`                              | Persists membership, names, collapsed state.          |
| `apps/web/src/uiStateStore.test.ts`                         | Covers that persistence.                              |
| `apps/web/src/connection/runtime.ts`                        | Client runtime carrying sidebar section grouping.     |
| `packages/client-runtime/src/state/threadGroups.ts`         | Shared group model for web and mobile.                |
| `packages/client-runtime/src/state/threadGroupTitleHttp.ts` | Remote-safe group title generation client.            |
| `packages/client-runtime/package.json`                      | Client grouping package dependencies.                 |
| `packages/contracts/src/environmentHttp.ts`                 | Types remote-safe group title generation.             |
| `apps/server/src/orchestration/ThreadGroupTitles.ts`        | Reuses the thread-title generation service.           |
| `apps/server/src/orchestration/http.ts`                     | Routes the group-title request.                       |
| `docs/user/thread-sidebar.md`                               | Documents the user-visible behavior.                  |

## upstream-fixes

### Need

Fixes the fork needs now that belong to no fork domain and would be correct in upstream T3 Code as they stand.
They sit at the bottom of the stack so each drops without touching a product domain.
The fork does not offer them upstream; it waits for upstream's own fix and retires the commit.

### Shape

| Aspect  | Rule                                                                              |
| ------- | --------------------------------------------------------------------------------- |
| Commit  | One upstream-native commit per fix, `Fork-Tier: bugfix`, `Fork-Upstreamable: yes` |
| Lane    | Created from `upstream/main`, so the fix carries no fork dependency               |
| Helpers | None shared across fixes; each must drop alone                                    |

### Terminal focus contract

Three commits share one behavior contract while each still drops alone.
A rebase that drops one must re-check the other two against it.

| Aspect         | Contract                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keys           | Thread jump keys, previous/next, and the palette shortcut switch threads while the terminal has focus; every other key stays in the shell                                |
| Navigation     | Thread navigation always lands in the composer, even with the terminal drawer open                                                                                       |
| Terminal focus | Taken only on explicit request: opening the drawer, creating or splitting a terminal, or `` ctrl+` `` from the composer. Returning and closing both land in the composer |
| Focus ring     | The focused pane shows a static ring in the focus-ring color; no animation                                                                                               |

Proof: `apps/web/src/components/ThreadTerminalDrawer.test.ts`, `ChatView.logic.test.ts`, and a Chrome pass on each landing.

### Retirement condition

Per commit: upstream ships the fix, and the next rebase drops the commit.
The domain retires when it is empty.

### Rebase scan

| Path                          | Why it matters                                                     |
| ----------------------------- | ------------------------------------------------------------------ |
| `**` (each commit's own diff) | A conflict usually means upstream fixed it differently; drop ours. |

## zmux-estate

### Need

A thread's terminal and worktree live in the same managed zmux estate the operator drives from the CLI.
Upstream spawns a plain shell per terminal and owns no session manager, so a thread's work is invisible outside the app.

### Shape

#### Session mode

`terminalSessionMode` is the single zmux switch.
`"zmux"` attaches new thread terminals through `zmux open` to the session `zmux session resolve` names for the checkout, binds a new thread worktree through `zmux wt --adopt`, and verifies the adopted worktree, public target, native tmux target, and native identity with an immediate `zmux session resolve --cwd`.

| Aspect              | Rule                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cleanup             | T3 snapshots native session id, server generation, and creation epoch before worktree removal and gives that exact identity back for conditional cleanup on the same endpoint |
| Incomplete identity | T3 preserves the session and reports an inspection-only manual recovery action                                                                                                |
| Ownership           | The physical checkout owns its managed session; threads and external clients are consumers                                                                                    |
| Refusal             | A refused or shared-viewer removal preserves every viewer, process, and durable record and reports the partial result                                                         |
| Adoption            | Reports whether the exact session was created, reused, restored, or renamed; Git or pre-remove refusals stay visible on the thread                                            |
| Legacy setting      | `zmuxSessions` folds into `terminalSessionMode` on load; an old opt-in becomes `"zmux"`                                                                                       |
| Fallback            | Every fallback to a plain shell prints its reason; a missing `zmux` binary degrades silently                                                                                  |
| Binder              | `apps/server/src/zmux/` holds the binder, called through `ProcessRunner` with inherited tmux variables stripped                                                               |

#### Demand leases

Visible terminal surfaces hold demand leases.
Web uses document visibility; Electron uses shown, non-minimized project-window demand over optional typed IPC and deliberately excludes focus.
Electron cannot observe Hyprland workspace occlusion, so a shown window on an inactive workspace still holds demand.
Client attach streams release immediately, then a server-owned cancellable grace timer detaches only the `zmux open` PTY; zero-demand opens use a longer configurable first-attach deadline.
Resume re-resolves the thread's persisted checkout before attaching, so renames follow the current verified target and removed worktrees cannot reuse a retained one.
Requested grid, retained UI layout, and bounded T3 scrollback stay client-owned.

#### Checkout moves

Threads move between existing checkouts through a durable requested and effective transition.
The server resolves both physical identities, compares the expected checkout root plus server-owned branch and worktree context, and queues behind active or pending turns.
Unrelated message, session, and activity updates do not invalidate the move.
Ordered checkout leases serialize source and destination mutation, and a dedicated drainable worker keeps a blocked move from stalling unrelated provider commands.

A move relocates a provider only when that thread already has a live provider runtime.
Dormant threads move durable metadata without spawning a provider and record a null effective provider checkout.
Every provider reuses its existing adapter continuation path and native resume cursor.
Partial failures retain provider availability, completed steps, and the observed effective checkout.
Detached `HEAD` stays a server-resolved identity and is never synthesized into a branch override.

Terminal follow and pin belong to each client.
Follow-mode terminals react to committed thread metadata on that client; pinned terminals and external zmux clients stay put.
Move commands and durable state carry no terminal attachment identities.

#### Persistence and suspension

The durable `projection_threads.checkout_move_json` column is fork-owned through the idempotent `apps/server/src/persistence/ForkSchema.ts` pass, run after `runMigrations`, never a numbered upstream migration whose sequential ids collide on rebase.
The same pass repairs shipped nightlies (`v0.0.39-hyprws-nightly.20260906.337` through `.341`) that recorded the fork column as migration row `(48, "ProjectionThreadCheckoutMove")`, deleting exactly that row before `runMigrations`.

Managed suspension stays internal.
Existing wire statuses and activity events stay decodable by released clients, which observe the optional `attachmentStatus` sibling.
Suspended activity and labels are last-known values.
Full suspended records count toward bounded inactive retention; eviction removes metadata but keeps a separately bounded exact-target identity lease without killing tmux targets.

### Retirement condition

Upstream terminals can attach to an operator-chosen external session manager, and worktree lifecycle exposes hooks a session manager can bind to.

### Rebase scan

| Path                                                                                                                                                                       | Why it matters                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/terminal/Manager.ts`                                                                                                                                      | Shell candidate resolution, demand leases, PTY suspension.                                                          |
| `apps/server/src/terminal/ManagedAttachmentLifecycle.ts`                                                                                                                   | Fork-only cancellable hidden-surface state machine.                                                                 |
| `apps/web/src/components/ThreadTerminalDrawer.tsx`                                                                                                                         | Surface and window demand determine attachment leases.                                                              |
| `apps/web/src/components/onboarding/WelcomeWizard.tsx`                                                                                                                     | Second `TerminalViewport` call site; fork props go here too.                                                        |
| `apps/web/src/state/terminalSessions.ts`                                                                                                                                   | Retained hook only; preserve upstream metadata indexing.                                                            |
| `apps/web/src/state/terminalAttachmentRetention.fork.ts`                                                                                                                   | Fork-only buffer and error retention across attach streams.                                                         |
| `apps/web/src/state/terminalSessions.test.ts`, `apps/web/src/state/terminalAttachmentRetention.fork.test.ts`                                                               | Only retention cases belong in the fork sibling.                                                                    |
| `apps/desktop/src/window/DesktopWindow.ts`                                                                                                                                 | BrowserWindow lifecycle publishes per-window demand.                                                                |
| `apps/desktop/src/preview/WindowPolicy.preload.ts`                                                                                                                         | Optional typed demand bridge for older shells.                                                                      |
| `packages/client-runtime/src/state/terminal.ts`                                                                                                                            | Attach atoms release without the generic idle TTL.                                                                  |
| `packages/contracts/src/terminal.ts`                                                                                                                                       | Optional attachment status preserves released-client decoding.                                                      |
| `apps/server/src/git/GitWorkflowService.ts`                                                                                                                                | Worktree create and remove; bind and unbind hook here.                                                              |
| `apps/server/src/server.test.ts`                                                                                                                                           | Zmux attachment and fallback through server seams.                                                                  |
| `apps/server/src/server.ts`                                                                                                                                                | Provides the zmux binder layer.                                                                                     |
| `apps/server/src/zmux/**`                                                                                                                                                  | Fork-only. A conflict means upstream grew a session model.                                                          |
| `packages/contracts/src/settings.ts`                                                                                                                                       | `terminalSessionMode` and its migration sit between upstream keys.                                                  |
| `apps/web/src/components/settings/SettingsPanels.tsx`                                                                                                                      | Settings UI for the switch; a busy upstream file.                                                                   |
| `apps/server/src/ws.ts`                                                                                                                                                    | Shares worktree lifecycle wiring with the binder.                                                                   |
| `apps/desktop/src/ipc/channels.ts`                                                                                                                                         | Carries the suspend channel for a hidden terminal.                                                                  |
| `apps/desktop/src/window/DesktopWindow.test.ts`                                                                                                                            | Suspension when a window hides.                                                                                     |
| `apps/server/src/git/GitManager.ts`                                                                                                                                        | Binds a thread worktree to its managed session.                                                                     |
| `apps/server/src/git/GitManager.test.ts`                                                                                                                                   | Covers that binding.                                                                                                |
| `apps/server/src/serverSettings.ts`                                                                                                                                        | Composes the migration with other stored server modes.                                                              |
| `apps/server/src/serverSettings.test.ts`                                                                                                                                   | The single setting driving attach and binding.                                                                      |
| `apps/web/src/components/ThreadTerminalDrawer.test.ts`                                                                                                                     | Focus and suspension in the drawer.                                                                                 |
| `apps/web/src/components/settings/settingsSearch.ts`                                                                                                                       | Indexes the zmux settings.                                                                                          |
| `packages/client-runtime/src/state/runtime.test.ts`                                                                                                                        | Suspended attachment state.                                                                                         |
| `packages/contracts/src/git.ts`                                                                                                                                            | Carries the managed session binding.                                                                                |
| `packages/contracts/src/ipc.ts`                                                                                                                                            | Declares the suspend channel.                                                                                       |
| `packages/contracts/src/settings.test.ts`                                                                                                                                  | Covers the zmux setting schema.                                                                                     |
| `apps/server/src/processRunner.ts`                                                                                                                                         | Strips tmux inheritance; upstream edits break bind.                                                                 |
| `apps/server/src/orchestration/decider.ts`                                                                                                                                 | Decides move states and rejects a turn on a moving thread.                                                          |
| `apps/server/src/orchestration/projector.ts`                                                                                                                               | Projects `checkoutMove` and the resulting checkout root.                                                            |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`                                                                                                               | The `ProjectionThreadCheckoutMoveRepositoryLive` provide line is the fork hook.                                     |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`                                                                                                          | Reads move state into reconnect snapshots.                                                                          |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`                                                                                                     | Covers that snapshot field.                                                                                         |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`                                                                                                           | Owns the move worker, sorted leases, typed failures.                                                                |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`                                                                                                      | Provider relocation and move validation.                                                                            |
| `apps/server/src/orchestration/Layers/CheckpointReactor.ts`                                                                                                                | Reconciles managed sessions after a branch change.                                                                  |
| `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`                                                                                                           | Covers that reconciliation.                                                                                         |
| `packages/contracts/src/orchestration.ts`                                                                                                                                  | Wire shapes for move commands, events, payloads.                                                                    |
| `packages/contracts/src/index.ts`                                                                                                                                          | Re-exports `checkoutMove.ts` from a block upstream edits.                                                           |
| `packages/client-runtime/src/operations/checkoutMove.fork.ts`, `packages/client-runtime/src/operations/commands.ts`, `packages/client-runtime/src/state/threadCommands.ts` | Fork owns the move command; `commands.ts` keeps a two-line re-export hook and `threadCommands.ts` only atom wiring. |
| `apps/web/src/state/entities.ts`                                                                                                                                           | The web merge calls the fork merge helper.                                                                          |
| `packages/client-runtime/src/state/checkoutMove.ts`                                                                                                                        | Re-attaches `checkoutMove` after the upstream merge, keeping `threadDetail.ts` identical.                           |
| `apps/web/src/components/ChatView.tsx`                                                                                                                                     | Resolves launch location from checkout mode and attachment.                                                         |
| `apps/web/src/components/BranchToolbarBranchSelector.tsx`                                                                                                                  | Locks branch selection while a move is in flight.                                                                   |
| `apps/web/src/terminal/ghostty/surface.ts`                                                                                                                                 | `resetSession` clears replaced-PTY state without discarding the viewer.                                             |
| `docs/architecture/terminal-renderers.md`                                                                                                                                  | Documents the visibility lifecycle and demand leases.                                                               |
| `docs/user/source-control.md`                                                                                                                                              | Documents moving a started thread between checkouts.                                                                |
| `docs/internals/terminal-runtime.md`                                                                                                                                       | Managed-attachment lifecycle prose; upstream moved this page once.                                                  |
| `apps/server/src/git/CheckoutMutationCoordinator.ts`, `apps/server/src/project/AgentSessionImporter.test.ts`                                                               | Every suite building `ProviderCommandReactor` must provide the coordinator and a `VcsDriverRegistry`.               |
| `apps/server/src/persistence/ThreadsCheckoutMove.fork.ts`, `apps/server/src/persistence/ThreadsCheckoutMove.fork.test.ts`                                                  | Fork-owned decorator and only reader/writer; upstream schema stays identical.                                       |
| `apps/server/src/persistence/ForkSchema.ts`                                                                                                                                | Owns idempotent column creation and the nightly repair.                                                             |
| `apps/desktop/src/preload.ts`                                                                                                                                              | Wraps `desktopBridge` in `exposePreviewCapability` and drops two members.                                           |
| `apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx`                                                                                                          | Mobile move state, route-scoped Follow and Pin, command wiring.                                                     |
| `apps/mobile/src/persistence/mobile-preferences.ts`                                                                                                                        | Persists the `terminalCheckoutModes` preference.                                                                    |
| `apps/server/integration/OrchestrationEngineHarness.integration.ts`                                                                                                        | Wires the reactor and coordinator into the harness.                                                                 |
| `packages/client-runtime/package.json`                                                                                                                                     | Exports the `./state/checkout-move` subpath.                                                                        |

## worktrunk-hooks

### Need

A thread worktree behaves like one created with `wt switch --create` on the same project: the hooks in `.config/wt.toml` seed the checkout on create and clean up on remove.
Upstream runs `git worktree add` and `remove` directly, so a project depending on those hooks gets a bare worktree and leaves per-branch state behind.

### Shape

| Aspect          | Rule                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode            | `ThreadEnvMode` gains `worktrunk` beside `local` and `worktree`, labelled "New worktrunk" wherever upstream offers "New worktree"; upstream's `worktree` is untouched                                     |
| Wire            | `worktrunk` never crosses the wire: schemas keep the two-value `WireThreadEnvMode` plus an optional `defaultThreadEnvModeFork` sibling, because a released client drops a payload with an unknown literal |
| Storage         | Events, projection database, and `t3.json` keep the wide `ThreadEnvMode`; `@t3tools/shared/threadEnvMode` owns both directions and `settings.json` migrates on read                                       |
| Marker          | A `worktrunk` thread sends `prepareWorktree.worktrunk: true` on its first turn; the server drops a `t3-worktrunk` marker in the worktree gitdir                                                           |
| Hooks           | `wt hook pre-start` and `post-start` run in the new worktree ahead of the `t3.json` setup script; `pre-remove` runs there and `post-remove` in the primary checkout                                       |
| Marker lifetime | `git worktree remove` deletes the marker with the gitdir, so no thread or project state records the mode                                                                                                  |
| Hook execution  | Every hook runs headless through `wt hook <type> --yes`; `pre-*` block, `post-start` returns once `wt` detached, a failed create hook lands as error activity                                             |
| Gating          | `.config/wt.toml` and `wt` on PATH gate every hook; without either the mode degrades to upstream `worktree`. There is no separate switch                                                                  |
| Unsupported     | Pull-request threads and mobile, which maps a `worktrunk` default to a plain worktree                                                                                                                     |
| Paths           | Worktree paths stay T3 Code's; the fork never delegates to `wt switch` or `wt remove`                                                                                                                     |
| Runner          | `apps/server/src/worktrunk/` holds the runner, called through `ProcessRunner` with tmux variables stripped                                                                                                |
| Persistence     | No persistence column. A future fork column needs the idempotent `ForkSchema.ts` pattern, never a numbered upstream migration                                                                             |

Local VCS status reports `worktrunk: true` while the marker exists, which is how a started thread's composer reads "Worktrunk".

### Retirement condition

Upstream worktree lifecycle exposes create and remove hooks a project can bind shell commands to.

### Rebase scan

| Path                                                                   | Why it matters                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/server/src/worktrunk/**`                                         | Fork-only. A conflict means upstream grew a hook model.            |
| `apps/server/src/provider/Drivers/AntigravityDriver.ts`                | Keeps child environments aligned with Worktrunk scrubbing.         |
| `packages/contracts/src/environment.ts`                                | `ThreadEnvMode` carries the third literal.                         |
| `packages/contracts/src/orchestration.ts`                              | `prepareWorktree.worktrunk` on the bootstrap payload.              |
| `packages/shared/src/threadEnvMode.ts`                                 | `isWorktreeEnvMode`; `=== "worktree"` must route through it.       |
| `packages/contracts/src/settings.ts`                                   | `defaultThreadEnvMode` pair, its patch and migration.              |
| `packages/contracts/src/settings.test.ts`                              | Worktrunk default beside upstream settings.                        |
| `apps/server/src/serverSettings.ts`                                    | Chains the stored-`worktrunk` settings migration.                  |
| `apps/server/src/orchestration/decider.ts`                             | Folds the wire pair back into the wide mode.                       |
| `apps/server/src/orchestration/projector.ts`                           | Splits the stored mode into the wire pair.                         |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`      | Same split on every project snapshot.                              |
| `apps/web/src/hooks/useHandleNewThread.ts`                             | Resolves the effective new-thread mode from the pair.              |
| `packages/shared/src/serverSettings.ts`                                | Replaces the thread-mode pair wholesale, not deep-merged.          |
| `apps/server/src/ws.ts`                                                | Thread bootstrap create; hooks run before the setup script.        |
| `apps/server/src/server.ts`                                            | Provides the Worktrunk hook runner layer.                          |
| `apps/server/src/server.test.ts`                                       | Worktrunk lifecycle through server seams.                          |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`           | Shares activity sequencing with worktrunk thread projection.       |
| `packages/contracts/src/git.ts`                                        | `worktrunk` on the local status result.                            |
| `apps/server/src/git/GitWorkflowService.ts`                            | Status carries the marker and decides the remove hooks.            |
| `apps/web/src/components/BranchToolbar.logic.ts`                       | `EnvMode`, its labels, every worktree-shaped resolver.             |
| `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`             | Composer Workspace picker: third item, icon, locked label.         |
| `apps/web/src/components/BranchToolbarBranchSelector.tsx`              | Routes the branch selector through `isWorktreeEnvMode`.            |
| `apps/web/src/components/BranchToolbar.tsx`                            | Mobile-width Workspace menu; the same third item.                  |
| `apps/web/src/components/ChatView.tsx`                                 | Sends `worktrunk: true` and feeds the status flag.                 |
| `apps/web/src/components/ChatView.logic.ts`                            | Shares worktree-shaped thread-start logic.                         |
| `apps/web/src/composerDraftStore.ts`                                   | Keeps worktrunk-backed drafts aligned with startup.                |
| `apps/web/src/lib/chatThreadActions.ts`                                | Routes worktrunk actions through the shared startup path.          |
| `apps/web/src/components/settings/SettingsPanels.tsx`                  | New threads select; a busy upstream file.                          |
| `apps/web/src/components/settings/settingsSearch.ts`                   | Indexes the worktrunk mode in settings search.                     |
| `apps/web/src/components/settings/settingsSearch.test.ts`              | Covers those entries beside upstream preferences.                  |
| `apps/web/src/components/settings/ProjectSettingsPanel.tsx`            | Project Workspace select.                                          |
| `apps/mobile/src/features/threads/new-task-flow-provider.tsx`          | Maps a `worktrunk` default to `worktree`.                          |
| `apps/server/src/git/GitManager.ts`                                    | Runs the Worktrunk hooks around a thread worktree.                 |
| `apps/server/src/git/GitManager.test.ts`                               | Hook invocation and the pinned fixture path.                       |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` | Thread env mode in the snapshot.                                   |
| `apps/server/src/orchestration/decider.projectThreadEnvMode.test.ts`   | The worktrunk thread mode decision.                                |
| `apps/web/src/components/GitActionsControl.tsx`                        | Hosts the worktree surfaces that replaced the switches.            |
| `packages/shared/src/projectSettings.ts`                               | Carries the sibling through project-scope resolution and clearing. |
| `packages/shared/src/projectSettings.test.ts`                          | Covers the sibling riding an override and dropping with its slot.  |
| `apps/web/src/components/settings/SettingInheritance.tsx`              | Decodes the stored fork env mode per inheritance layer.            |
| `apps/web/src/components/settings/scopedSettings.ts`                   | Scopes `defaultThreadEnvModeFork` alongside upstream.              |
| `apps/web/src/components/settings/scopedSettings.test.ts`              | Covers that scoping beside the upstream cases.                     |
| `packages/shared/package.json`                                         | Exports the `./threadEnvMode.fork` subpath.                        |
| `apps/server/src/persistence/Services/ProjectionProjects.ts`           | Decodes through `ForkThreadEnvMode`; carries `worktrunkHooks`.     |

## Adding a domain

A new domain needs its own section with the same four headings, and a row in the domain index.
Its name becomes the `Fork-Domain` trailer of its first commit.

| #   | Question                                                |
| --- | ------------------------------------------------------- |
| 1   | What does upstream not do, stated as behavior?          |
| 2   | What would upstream ship for this domain to be deleted? |
| 3   | Which upstream paths does it touch?                     |

If the third answer is "many files across unrelated systems", the change is probably a bugfix and belongs to `upstream-fixes`.
Keep the domain's new code in its own files so it replays cleanly.
See [Extracting a domain](./fork-development.md#extracting-a-domain).
