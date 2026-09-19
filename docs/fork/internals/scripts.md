# Scripts

> For maintainers. Using T3 Code? See [docs/user](../user/).

## First checkout

T3 Code uses [Vite+](https://viteplus.dev/guide/).
Install the global `vp` command, install dependencies, then start the dev stack:

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

Node 24 is required; Bun is optional, because the server picks Bun adapters only when it detects Bun.
`vp run dev` prints a one-time pairing URL; open it so the first browser navigation is authenticated.

## Dev

| Command                                | What it does                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp run dev`                           | Starts contracts, server, and web in watch mode.                                                                                                                                  |
| `vp run dev:server`                    | Starts just the server, on Node, watching server and shared-package source while ignoring dependency-install churn; without Bun it selects `NodePtyAdapter` and `NodeHttpServer`. |
| `vp run dev:web`                       | Starts just the Vite dev server for the web app.                                                                                                                                  |
| `vp run dev:desktop`                   | Starts the Electron shell against the dev server.                                                                                                                                 |
| `vp run dev:desktop:agent:url`         | Prints the live worktree instance's recorded CDP origin.                                                                                                                          |
| `vp run dev:marketing`                 | Starts the Astro marketing site.                                                                                                                                                  |
| `vp run hypr:workspace [-t <seconds>]` | Captures the active app's Hyprland workspace, optionally waits for the user to switch, then reports the newly focused workspace and the app's original one.                       |

Dev-runner flags go directly after the root task name: `vp run dev --home-dir /tmp/t3code-dev`.
`vp run dev --browser` auto-opens a browser; it is off by default.
The runner writes `T3CODE_NO_BROWSER` itself from that flag, so `T3CODE_NO_BROWSER=0` in your environment has no effect; use `--browser`.

### Worktree setup

`node scripts/setup-worktree.ts` runs new-worktree setup without installed dependencies or a loaded Vite+ task graph.
It installs the frozen lockfile, derives the canonical checkout from Git's absolute common directory, creates absolute `.env` and `infra/relay/.env` symlinks, and warms the web dependency cache.
Reruns are safe: only stale symlinks are replaced, and a regular destination file is never overwritten.
A missing canonical environment file becomes an intentional dangling link, so it works once that file exists.
`vp run setup:worktree` is the equivalent alias once dependencies are installed.
Setup starts no development app and resets no fixture state.

### Dev app surfaces

`vp run dev:app [--external|--preview|--desktop]` creates or reuses `.t3/test-project` and starts the selected surface against this checkout's isolated `.t3` home, defaulting to the external browser.
Native agents use `--preview`, wait for the printed ready URL, then pass that exact URL to `preview_open`; clients without integrated preview use the browser.
`--desktop` keeps DevTools off, scopes the Electron profile and single-instance lock to `.t3/electron` without moving provider credentials, records CDP, and accepts `--workspace <+1|-1|id|none>`.
Stop the owned run before switching surfaces; later launches keep fixture edits, project registration, threads, and authentication.
**Dev Web** refuses remote, relay, and SSH environments before starting a terminal; select the primary local environment.
A slow cold build keeps its preview listener for ten minutes after terminal attachment, or until terminal exit or navigation away from the thread.
On timeout, inspect the terminal and stop the owned run before retrying.
For a consumed or expired pairing link, run `node apps/server/src/bin.ts pair --base-dir "$PWD/.t3"` from that checkout; the explicit home keeps base-checkout recovery away from installed stable.

### Sharing over the tailnet

`vp run dev --share` also publishes the web port over HTTPS on this machine's tailnet.
The startup pairing URL is built against the shared origin; the mapping is removed on exit.
Shared runs default to bundled dev mode (`T3CODE_BUNDLED_DEV=1`) because a remote browser pays a round trip per import level in unbundled dev, turning a cold module graph into minutes of waterfall.
Set `T3CODE_BUNDLED_DEV=0` to opt back out.
The web entry loads the app with a dynamic import so React refresh starts before shared UI chunks run.
Keep app imports out of that entry: a static import can work on the first load and then fail on reload after Vite splits code for lazy routes.
Bundled dev rebuilds CSS from Tailwind's watched files, and its Vite-only hot-update hook is disabled here because Rolldown supplies no Vite server or module graph.

### Desktop agent instance

`vp run dev:desktop:agent` starts or restarts this worktree's desktop dev stack.
It disables detached DevTools, allocates a stable free CDP port from base 9223, and records the live endpoint under `XDG_STATE_HOME`.
Placement is the compositor's by default.
Set `T3CODE_DESKTOP_AGENT_WORKSPACE` in the repo's gitignored `.env` to `-1` or `+1` for placement beside the invoking numbered workspace, or to a positive ID for fixed placement.
`--workspace <selector>` overrides the repo setting for one run; `none` restores default placement.
Relative selectors resolve once before launch, and targeted windows map without taking focus across watcher relaunches.

### Dev state directories

From a linked **git worktree**, dev commands default to that worktree's gitignored `.t3` even when `T3CODE_HOME` is set, storing state in `<worktree>/.t3/userdata`.
Submodules are not worktrees and keep the normal precedence.
From the **main checkout**, they use `~/.t3/dev`, keeping development state out of `~/.t3/userdata`.
An explicit `--home-dir <path>` stores state under `<path>/userdata`; the base directory stays available for caches, worktrees, and other shared data.

## Build, check, test

| Command                | What it does                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp run build`         | Fans out over `apps/*`, `packages/*`, `oxlint-plugin-t3code`, and `scripts`. Desktop, marketing, server (which depends on web), and web run build tasks; shared packages are bundled transitively, never built separately. |
| `vp run build:desktop` | Builds the desktop pipeline (desktop plus server).                                                                                                                                                                         |
| `vp run start`         | Runs the production server, serving the built web app as static files.                                                                                                                                                     |
| `vp check`             | Vite+ format, lint, and type checks. This repo sets `typeCheck: false` in its lint options, so workspace type checking runs separately.                                                                                    |
| `vp run typecheck`     | Strict TypeScript checks for all packages.                                                                                                                                                                                 |
| `vp run test`          | Runs workspace tests.                                                                                                                                                                                                      |
| `vp run lint:mobile`   | Mobile native static analysis (`scripts/mobile-native-static-check.ts`).                                                                                                                                                   |

**`node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...`** inspects or seeds an isolated T3 SQLite database; writes create a private backup first.

### Fork release and ledger

**`node scripts/fork-release-version.ts --channel <stable|nightly>`** resolves fork release metadata for `.github/workflows/hyprws-release.yml`.
Stable requires `--tag vX.Y.Z-hyprws.N`.
Nightly requires `--date YYYYMMDD --run-number N --sha SHA`, derives the next patch through the shared nightly-version helpers, and emits `X.Y.Z-hyprws-nightly.YYYYMMDD.N`.
Both channels take the previous tag from their own fork tag family for generated release notes.
`--github-output` appends version, tag, name, previous tag, and release flags to `GITHUB_OUTPUT`; otherwise it prints them.

**`vp run fork:delta`** (`scripts/fork-delta.ts`) lists active fork commits above `upstream/main` by `Fork-Domain` and `Fork-Tier` trailer, omitting subjects recorded under Retired in the fork ledger.
`--check` exits 1 on an invalid trailer or a still-present retired subject; `--json` emits the active ledger for tooling.
`--domain <name> --shas` prints one domain's SHAs in stack order for `git cherry-pick` onto upstream.
With `--check`, `--squash-body <file>` requires explicit `--base` and `--head`, compares their merge base with the prospective squash head for shipped wire changes, and verifies the body ends with that commit's trailer block.

**`vp run fork:preflight`** (`scripts/fork-preflight.ts`) checks the preconditions the fork-sync gates depend on: `rerere.enabled`, the `origin` and `upstream` remotes, a freshly fetched `origin/hyprws`, a `main` mirror level with `upstream/main`, and installed dependencies.
It fetches rather than trusting the last unrelated fetch, and exits 1 naming every unmet precondition and its fix.
Gates call it first and refuse on failure, so a stale ref is named before a gate acts on it.
`--tag-pinned` reports mirror currency without requiring it, for a caller already pinned to a tag that cannot move.

**`vp run fork:lockfile`** (`scripts/fork-lockfile.ts`) proves the committed `pnpm-lock.yaml` records the specifiers its manifests declare.
It refuses an uncommitted lockfile rather than overwrite it, reruns `vp install --lockfile-only`, classifies any difference with the `importers`/`snapshots` split the fork-sync replay verification uses, and restores the committed bytes in every outcome, including a throw or interrupt.
`pnpm-lock.yaml` is the fork's only regenerable path, so a hand-merged or replayed lockfile has no reviewable intent to recover; this fails it on the branch that introduced it, not at a rebase stop.
Run it on any branch that changes a package manifest.
Only `importers` drift fails: a full resolution re-picks every open range, not just the ranges a branch touched, so regenerating on an older lockfile moves transitive pins no manifest asked for.
That churn lands in `snapshots:`, so a snapshot difference is a note and exits 0.
Keep this off the required-check list for the same reason: a green run would depend on when the registry last moved.

### Fork sync gates

**`vp run fork:orient --target vX.Y.Z`** (`scripts/fork-orient.ts`) is Gate 1 of the fork-sync flow.
It runs `fork:preflight`, proves the target is a tag reachable from `upstream/main` with `git merge-base --is-ancestor`, then prints to stdout: target, source, shared base, mirror currency, feasibility, automerged overlap, retire candidates, an `upstream-watch` verdict per open issue against that tag, and the Gate 1 Stop block.
It writes no file, ref, or GitHub thread.
It imports only Node builtins and its sibling scripts, so `node scripts/fork-orient.ts` runs in a worktree with no dependencies installed; installed dependencies are reported, not required.
It exits 1 when a precondition is unmet, the tag is unproved, or the watch sweep fails.

**`vp run fork:scan`** (`scripts/fork-scan.ts`) checks every fork domain's `### Rebase scan` table in the fork ledger.
It groups the fork stack by `Fork-Domain`, intersects the files those commits change with the files upstream changed over the same base, and exits 1 naming each domain and file the scan table omits.
`--target <ref>` picks the upstream ref (default `upstream/main`), `--head <ref>` the fork ref, `--base <ref>` their merge base.
Gate 3 runs it from the rehearsed worktree as `vp run fork:scan --target vX.Y.Z`: the rehearsed-head typechecks that surface silent seams run only when `--head` resolves to the checkout `HEAD`, so any other ref reports declarations alone.
It also collects the [ledger guards](./fork-development.md#ledger-guards-run-in-the-scan), namely `hot-seam`, `upstream-test`, `footprint`, `replaced-export`, and `lockfile`, printing each as a `WARN` line.
General warnings are advisory unless `--strict` makes them fatal.
`--since <ref>` limits warnings to later commits and makes adopted authoring guards fatal without `--strict`.
`--same-tree-rewrite-of <ref>` scopes a historical replay to no newly authored commits, only after proving the head has exactly the source ref's full tree.
`--replay-of <ref>` does the same for a rebase rehearsal, only after proving the head omits that trunk and sits on a tagged upstream commit the trunk has not reached.

**`vp run fork:retire-pass`** (`scripts/fork-retire-pass.ts`) runs the retire pass over the fold worklist, the P0 gate before the first fold: retire before reshape.
It takes `--worklist <file>` of subjects (one per line; markdown checkboxes and `(ledger: …)` annotations tolerated), `--target <ref>` upstream tree to probe, and `--base <ref>` plus `--source <ref>` resolving subjects to commits (default: merge base of `upstream/main` and `HEAD`).
Each row reuses the walk's own retire predicates, `retireCandidateMatches` scoped by `RETIRE_PROBE_EXCLUSIONS` and `isRetireEvidenceSite`, emitting `retire-candidate` with its evidence sites, `no-evidence`, or `not-in-range`.
Verdicts come back from the fork retirement ledger by subject as `retire`/`keep`/`partial`/`pending`; the driver writes nothing and drops nothing.
When at least half the probed rows read retire candidate it prints the over-broad-read warning from RSI-Software/t3code-hyprws#688, because a probe that reads everything as retire buries the proven keeps.
`--json` emits the rows for tooling.

**`vp run fork:sync <verb>`** (`scripts/fork-sync.ts`) owns the human unblock state machine in one versioned external report.
`unblock-list` emits selectable targets without accepting one; `unblock-orient` binds the human's explicit selection.
Repeatable `unblock-rehearse` calls create or resume the collision-free Worktrunk lane and own generated lockfile handling plus every comment-char-neutralised rebase continuation.
`unblock-check` stabilises lock drift, installs the replayed manifests, runs focused checks, and emits the structured decision surface.
`unblock-apply` validates the signed record, calls `fork:sync-gate`, and performs only the recorded leased apply.
`rewrite-build --manifest <reviewed-json> [--json]` constructs unreferenced objects from exact snapshot changes and emits a verified receipt; `rewrite-rehearse --manifest` binds that same-base candidate into the check, review, and apply flow.
The [construction runbook](../operations/fork-sync.md#historical-rewrite-construction) defines its executable manifest and proof refusals.
`fold-reshape` derives such a manifest from landed reshape squashes: per-path blame attribution (`--attribute` and `--leave` overrides, recorded in the manifest so a reviewer can read them back), a 3-way blob merge propagated through every slot between origin and reshape as unreferenced blobs, and the manifest JSON as the only ref.
`--reshape` takes a comma-separated list to batch several landed reshapes into one manifest.
List order is the fold order, not commit history order: a reshape that folds first settles its own origin for a path, so a later reshape whose blame chains to that reshape (a shared seam, not a real fork commit) resolves through it instead of refusing.
The script renders and validates the Markdown record schema; its focused tests are that schema's definition.

**`vp run fork:sync-gate --tag vX.Y.Z --record <path>`** (`scripts/fork-sync-gate.ts`) guards the signed-off agent apply step.
Stable tags are the default; `--allow-nightly` also accepts `vX.Y.Z-nightly.YYYYMMDD.N` for a deliberate nightly-target rehearsal.
The record path must resolve outside the repository so operational evidence cannot enter the replayed stack.
It refuses on any unmet preflight precondition it requires, and exits 1 unless that external record has a full `expected_old` equal to the `origin/hyprws` head the preflight fetched.
Its slice is already pinned to a tag, so mirror currency is reported rather than required.
It takes that head from the preflight rather than resolve the ref itself, so it cannot pass a lease against a ref nothing fetched.
It only reports readiness; it never pushes, tags, releases, or posts the record.

**`vp run fork:auto-rebase --fetch --mode candidate`** (`scripts/fork-auto-rebase.ts`) reads the rebase feasibility window, selects its newest upstream stable or nightly tag, and replays the complete fork stack in a detached temporary worktree.
It snapshots each intermediate stable tag to a create-only `release/vX.Y.Z-hyprws` branch.
Candidate mode force-updates `hyprws-next`; `on` also records `hyprws-previous` and rewrites `hyprws` with an explicit expected-old lease, and a rejected lease restores both the prior recovery ref and that run's snapshots.
`off` reports without mutating refs.
Verification reuses the checkout install only when the target leaves every workspace manifest and `pnpm-lock.yaml` unchanged; otherwise it runs `vp i` in the detached worktree.
`--dry-run` selects, rebases, and verifies without any push.
`--target` accepts only an upstream release tag inside the clean window.
The workflow consumes `--summary`, `--issue-json`, and `--github-output` for its run summary and fork-local `Notification 🔔` issues.

### Fork reporting

**`vp run fork:rebase-report`** (`scripts/fork-rebase-report.ts`) generates the gitignored Markdown and schema-v3 JSON orientation snapshot under `docs/internals/generated/`, from `origin/hyprws` to `upstream/main`.
Its read-only feasibility section walks the upstream first-parent lane with `git merge-tree`, attributes each hard-conflict file and hunk count to its introducing fork commit, domain, and tier, and lists overlapping files Git automerged for semantic review.
Its Retire candidates section marks commits whose patch is already upstream or whose hunks overlap or sit adjacent to upstream hunks, and carries forward Retired and Kept decisions by subject from the fork ledger.
Pass `--target vX.Y.Z` to inspect a release and `--fetch` to refresh both remotes first.
`--check` compares byte-for-byte against the files on disk without writing; a write run producing those same bytes prints `unchanged:` instead of `updated:` and leaves the file alone.
The `hyprws-upstream-sync.yml` run uploads a fresh pair on every `hyprws` push and on a schedule; the report is never committed because it embeds the fork head.

**`vp run fork:rebase-report:artifact`** downloads and validates the latest successful workflow artifact under `.dump/runs/fork-rebase-report/<run-id>/`.
`--run <id>` inspects a specific run.
An existing run directory is reused because workflow artifacts are immutable.

**`vp run fork:upstream-watch`** (`scripts/fork-upstream-watch.ts`) sweeps the fork's open `upstream-watch` issues and resolves each upstream item their bodies cite.
Per citation it reports whether the upstream pull request merged and whether its merge commit is in the rebase target, so the sync's orient step knows which watches ride the rebase.
The list is paged to completeness and the sweep fails rather than report a truncated one, because a capped sweep looks like a clean one.
The endpoint pages by offset with no cursor, so a multi-page walk repeats until two walks see the same issue numbers; otherwise an issue closing mid-walk slides a still-open one behind the cursor.
A closed upstream issue is `fix-uncited` only when it closed as completed: a `not_planned` closure has no fixing pull request to find, so it is `dropped`.
An issue takes the least advanced verdict among citations that can still advance, so a spent citation never strands a watch whose fix has landed.
`--target vX.Y.Z` picks a release and `--json` emits rows for tooling.
It reads GitHub and Git only, and recognizes a citation only inside a code span, so it can never fire a cross-reference on an upstream thread.

### Upstream reference guard

**`vp run fork:upstream-refs <file>`** (`scripts/fork-upstream-refs.ts`) scans a fork issue, comment, or pull-request body for a live upstream reference, reading stdin when no path is given.
Fenced blocks, code spans, and HTML comments are ignored; anything left live exits 1, one finding per line as `<line>:<column> <reference> (<label>)`, because GitHub would post a backlink on the `pingdotgg/t3code` thread.
A bare `#4379` or `GH-4379` is a finding too: GitHub resolves a number this fork never issued against the repository it was forked from, and the guard cannot tell offline which numbers the fork holds.
Writing a fork reference as `RSI-Software/t3code-hyprws#108` clears it and still renders as `#108`.
An upstream URL naming no item (`/issues/new`, `/pull/new/main`, `/discussions/categories/ideas`) is not a finding.
See [Upstream citations](./fork-development.md#upstream-citations) for the wrapping forms.

Run it against the body file before publishing.
That run is the gate: GitHub posts the backlink the moment the issue, comment, or pull request is created, and nothing afterwards can withdraw it.
Fork CI re-runs the guard on every pull-request body as a backstop, which reports a backlink that already fired rather than prevent one.

What the guard does not cover, deliberately:

| Gap                              | Detail                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue bodies and comments        | No CI backstop. Only the pre-publication run covers them, so a landing tool that publishes without it leaves them unguarded.                                                                                                                                      |
| Titles                           | Never scanned. Whether a title creates a backlink is unverified, and confirming it would mean posting upstream.                                                                                                                                                   |
| A pull request off `hyprws`      | Never reaches `.github/workflows/hyprws-ci.yml`.                                                                                                                                                                                                                  |
| Every bare number                | Reported, including one naming a fork item. The guard has no network, so it cannot ask which numbers this fork holds and reads the ambiguity as upstream. Expect this on prose carried down from upstream: `docs/internals/t3-connect.md` cites `#5051` that way. |
| `<pre>`, `<style>`, `<textarea>` | Read as ending at the next blank line rather than at the closing tag, so a citation after that blank is reported although GitHub prints it literally. Errs toward reporting.                                                                                      |
| Link and image text              | Not excluded, so `[#107](…)` and `[pingdotgg/t3code#4379](…)` are reported although GitHub links only the destination. Errs toward reporting.                                                                                                                     |

The Markdown reader is not a CommonMark parser.
It masks fenced blocks, indented code, code spans, HTML comments, and blockquote containers, and splits inline pairing on blank lines, ATX and setext headings, thematic breaks, list starts, deeper blockquotes, GFM table cells, and HTML blocks that may interrupt a paragraph.
Every rule above was checked both ways against GitHub's own renderer, and no counter-example erring the other way survived this round.
It remains an approximation, so an untried shape can pair across a boundary it does not know.

## Desktop artifacts

**`vp run dist:desktop:artifact --platform <mac|linux|win> --target <target> --arch <arch>`** builds one desktop artifact for that platform, target, and arch.

**`vp run dist:desktop:dmg`** builds a shareable macOS `.dmg` into `./release`.
Architecture defaults to the host, so Apple Silicon produces an arm64 DMG; force one with `dist:desktop:dmg:arm64`, `dist:desktop:dmg:x64`, or `--arch <arm64|x64|universal>`.

**`vp run dist:desktop:linux`** builds a Linux AppImage into `./release`.

**`vp run dist:desktop:win`** builds a Windows NSIS installer into `./release`; `:arm64` and `:x64` variants exist.

### Linux AppImage prerequisites

Linux AppImage packaging compiles the Rust resource monitor and the libsecret browser import helper.
Install a Rust toolchain, the standard C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick first.

Ubuntu and Debian:

```bash
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```bash
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```bash
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

Linux desktop development needs that same toolchain.
Its build and launch commands compile `native/browser-secret/main.c` into the gitignored native build directory, and releases place the executable in `resources/browser-secret`, outside `app.asar`.
The helper performs a read-only Chromium schema lookup through libsecret and writes the exact secret bytes to its stdout pipe.
Exit codes are 2 for a missing key, 3 for denied or locked access, and 4 for other keyring failures; the desktop importer preserves these distinctions.

The artifact script checks these capabilities before the web and desktop builds, reporting every failed check together with the Ubuntu/Debian install command.
It compiles and links tiny temporary programs, so it also catches installed runtime X11 libraries missing their development headers or linker symlinks.

### macOS DMG prerequisites

Install the Xcode Command Line Tools and Rust before building a DMG:

```bash
xcode-select --install
```

Install Rust from [rustup.rs](https://rustup.rs).
The artifact script checks Cargo, Clang, Make, `sips`, and `iconutil`; universal builds also need `lipo`.
It verifies Rust has every requested target; add missing ones with:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Unsigned local builds need no Apple credentials.
`--signed` also requires the certificate, provisioning profile, team ID, and notarization configuration described below.

### Windows installer prerequisites

Install Rust from [rustup.rs](https://rustup.rs), Python 3, and Visual Studio Build Tools.
In the Visual Studio Installer, select **Desktop development with C++** and include:

- **MSVC** x64/x86 build tools
- **Windows SDK** 10 or 11
- **MSVC Spectre** mitigated libraries

ARM64 installers need the MSVC ARM64 build tools and Spectre-mitigated libraries instead of the x64/x86 components.

Add the Rust target matching the installer architecture:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an arm64 installer:
rustup target add aarch64-pc-windows-msvc
```

Windows supplies `tar.exe`; it is checked when `--wsl-prebuild` makes the artifact include the WSL runtime.
electron-builder downloads NSIS, which needs no separate installation.
When `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true` points the build at an existing resource monitor, the script skips the Rust and Visual Studio checks because it compiles no monitor.
Unsigned local builds need no Azure credentials.
`--signed` also requires the Azure Trusted Signing configuration described below.

### Desktop `.dmg` packaging notes

| Topic           | Note                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing         | Default build is unsigned and not notarized, for local sharing. Add `--signed` to allow code signing and notarization when configured in CI or secrets.                                                                                                                                                                                                                     |
| Icon            | Uses `assets/prod/black-macos-1024.png` as the production app icon source.                                                                                                                                                                                                                                                                                                  |
| Chrome          | Follows the release channel: neutral for Latest, the Nightly sky artwork for Nightly, Blueprint exclusive to Dev builds. Packaging rasterizes the selected SVG into standard and Retina PNGs inside the disposable staging directory.                                                                                                                                       |
| Window          | The Finder window is 540×412 while its background is 540×380; the extra 32px covers the title bar included in Finder's window bounds.                                                                                                                                                                                                                                       |
| App URL         | Production windows load the bundled UI from the `t3code://app/` root URL, not a `127.0.0.1` document URL and not an explicit `index.html` path.                                                                                                                                                                                                                             |
| Backend         | Packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an auth token for WebSocket and API traffic.                                                                                                                                                                                                                                        |
| First launch    | A tester can still open it on macOS by right-clicking the app and choosing **Open**.                                                                                                                                                                                                                                                                                        |
| Staging         | Keep staging files for debugging package contents with `vp run dist:desktop:dmg --keep-stage`.                                                                                                                                                                                                                                                                              |
| macOS secrets   | Signed builds also require `T3CODE_APPLE_TEAM_ID` and `T3CODE_MACOS_PROVISIONING_PROFILE`. The passkey RP domain is derived from `T3CODE_CLERK_PUBLISHABLE_KEY` unless `T3CODE_CLERK_PASSKEY_RP_DOMAINS` overrides it.                                                                                                                                                      |
| Windows secrets | Windows `--signed` uses Azure Trusted Signing and expects `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`, plus Azure authentication vars such as `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` for a service principal with secret. |

## Browser development

`dev` and `dev:web` leave `VITE_HTTP_URL` and `VITE_WS_URL` unset so the browser resolves the backend from `window.location.origin`.
Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the server, so one bundle works from localhost or a tailnet hostname.

## Running multiple dev instances

Worktrees derive a preferred port offset from their path.
Default ports are server `13773` and web `5733`; a shifted port is `base + offset`.

```bash
T3CODE_DEV_INSTANCE=branch-a vp run dev:desktop
```

Offset resolution, in order:

| #   | Source                | Rule                                                                                             |
| --- | --------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `T3CODE_PORT_OFFSET`  | Must be a non-negative integer; negative values are rejected.                                    |
| 2   | `T3CODE_DEV_INSTANCE` | An all-digit value is used directly as the offset; any other non-empty value is hashed into one. |
| 3   | Worktree path         | Hashed into an offset.                                                                           |

Collision scanning depends on the mode:

| Mode                 | Scans       | Shifts                              |
| -------------------- | ----------- | ----------------------------------- |
| `dev:web`            | Web port    | Web offset only                     |
| `dev:server`         | Server port | Server offset only                  |
| `dev`, `dev:desktop` | Both        | Both, together as one shared offset |

An explicit server or dev-URL override removes that port from the availability check.
Treat the `[dev-runner]` output as authoritative.
