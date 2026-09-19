# Scripts

> For maintainers. Using T3 Code? See [docs/user](../user/).

## First checkout

T3 Code uses [Vite+](https://viteplus.dev/guide/).
Node 24 is required; Bun is optional, and the server picks Bun adapters only when it detects Bun.

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

`vp run dev` prints a one-time pairing URL; open it so the first navigation is authenticated.

## Dev

| Command                        | What it does                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `vp run dev`                   | Contracts, server, and web in watch mode                             |
| `vp run dev:server`            | Server only, on Node, ignoring install churn                         |
| `vp run dev:web`               | Vite dev server for the web app                                      |
| `vp run dev:desktop`           | Electron shell against the dev server                                |
| `vp run dev:desktop:agent`     | Start or restart this worktree's desktop dev stack                   |
| `vp run dev:desktop:agent:url` | Print the live instance's recorded CDP origin                        |
| `vp run dev:app`               | Create or reuse `.t3/test-project` and start one surface             |
| `vp run dev:marketing`         | Astro marketing site                                                 |
| `vp run setup:worktree`        | New-worktree setup (`node scripts/setup-worktree.ts` without deps)   |
| `vp run hypr:workspace`        | Report the active app's Hyprland workspace before and after a switch |

Runner flags follow the root task name: `vp run dev --home-dir /tmp/t3code-dev`.
`--browser` auto-opens a browser and is off by default; the runner owns `T3CODE_NO_BROWSER`, so setting it yourself does nothing.

### Worktree setup

Setup installs the frozen lockfile, links `.env` and `infra/relay/.env` from the canonical checkout, and warms the dependency cache.
Reruns replace only stale symlinks and never overwrite a regular file.
A missing canonical file becomes an intentional dangling link that works once the file exists.

### Dev app surfaces

`vp run dev:app [--external|--preview|--desktop]` runs against this checkout's isolated `.t3` home.

| Flag        | Use                                                                       |
| ----------- | ------------------------------------------------------------------------- |
| default     | External browser                                                          |
| `--preview` | Native agents: wait for the ready URL, pass it to `preview_open`          |
| `--desktop` | DevTools off, profile in `.t3/electron`, records CDP, takes `--workspace` |

Stop the owned run before switching surfaces; later launches keep fixtures, threads, and authentication.
Dev Web refuses remote, relay, and SSH environments before starting a terminal.
A cold build holds its preview listener for ten minutes after attachment.
For a spent pairing link, run `node apps/server/src/bin.ts pair --base-dir "$PWD/.t3"` from that checkout.

### Sharing over the tailnet

`vp run dev --share` publishes the web port over HTTPS on this machine's tailnet, builds the pairing URL against that origin, and removes the mapping on exit.
Shared runs default to bundled dev (`T3CODE_BUNDLED_DEV=1`) because unbundled dev costs a remote browser one round trip per import level.
The web entry loads the app through a dynamic import, so keep app imports out of it: a static import can survive the first load and fail after Vite splits lazy routes.

### Desktop agent instance

`dev:desktop:agent` disables detached DevTools, allocates a stable free CDP port from base 9223, and records the endpoint under `XDG_STATE_HOME`.
Placement is the compositor's unless `T3CODE_DESKTOP_AGENT_WORKSPACE` in the gitignored `.env` sets `-1`, `+1`, or a fixed ID.
`--workspace <selector>` overrides it for one run; `none` restores default placement.

### Dev state directories

| Where you run it    | State                                               |
| ------------------- | --------------------------------------------------- |
| Linked git worktree | `<worktree>/.t3/userdata`, outranking `T3CODE_HOME` |
| Main checkout       | `~/.t3/dev`                                         |
| `--home-dir <path>` | `<path>/userdata`                                   |

Submodules are not worktrees and keep the normal precedence.

## Build, check, test

| Command                | What it does                                                 |
| ---------------------- | ------------------------------------------------------------ |
| `vp run build`         | Fans out over apps, packages, the oxlint plugin, and scripts |
| `vp run build:desktop` | Desktop pipeline (desktop plus server)                       |
| `vp run start`         | Production server, serving the built web app statically      |
| `vp check`             | Format, lint, type checks; this repo type-checks separately  |
| `vp run typecheck`     | Strict TypeScript for all packages                           |
| `vp run test`          | Workspace tests                                              |
| `vp run lint:mobile`   | Mobile native static analysis                                |

`node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path>` inspects or seeds an isolated T3 SQLite database, backing up first on a write.

## Fork scripts

The [fork-sync runbook](../operations/fork-sync.md) owns the walk verbs, gate order, and release shape.
This table is the entry-point index.

| Command                       | What it does                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `fork:delta`                  | Lists active fork commits by trailer; `--check` fails an invalid trailer or a present retired subject |
| `fork:preflight`              | Proves rerere, both remotes, a fresh `origin/hyprws`, a level `main`, installed deps                  |
| `fork:lockfile`               | Proves the committed lockfile records its manifests' specifiers                                       |
| `fork:orient`                 | Gate 1: proves the target tag and prints feasibility, retire candidates, and watch verdicts           |
| `fork:scan`                   | Checks every domain's rebase-scan table and collects the ledger guards                                |
| `fork:retire-pass`            | Probes the fold worklist for retire candidates before the first fold                                  |
| `fork:sync <verb>`            | The human unblock state machine, in one external record                                               |
| `fork:sync-gate`              | Guards the signed-off apply against a tag and an external record                                      |
| `fork:auto-rebase`            | Replays the stack onto the newest feasible tag in a detached worktree                                 |
| `fork:rebase-report`          | Generates the gitignored orientation snapshot under `docs/internals/generated/`                       |
| `fork:rebase-report:artifact` | Downloads and validates the latest workflow artifact                                                  |
| `fork:upstream-watch`         | Resolves the upstream items open `upstream-watch` issues cite                                         |
| `fork:upstream-refs`          | Refuses a live upstream reference in a body about to be published                                     |
| `fork-release-version.ts`     | Resolves fork release metadata for the release workflow                                               |

Notable refusals:

| Command                            | Refusal                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `fork:delta --check --squash-body` | Needs explicit `--base` and `--head`                                          |
| `fork:lockfile`                    | Fails on `importers` drift only, and restores committed bytes even on a throw |
| `fork:orient`                      | Needs no installed dependencies, so it runs in a bare worktree                |
| `fork:scan --since`                | Makes adopted authoring guards fatal without `--strict`                       |
| `fork:sync-gate`                   | Needs a record resolving outside the repository                               |
| `fork:upstream-watch`              | Fails rather than report a truncated sweep                                    |

### Upstream reference guard

`vp run fork:upstream-refs <file>` scans a body for a live upstream reference, reading stdin when no path is given.
Fenced blocks, code spans, and HTML comments are ignored; anything left live exits 1.
A bare `#4379` is a finding too, because GitHub resolves it against `pingdotgg/t3code` and the guard cannot tell offline which numbers the fork holds.
An upstream URL naming no item is not a finding.
[Upstream citations](./fork-development.md#upstream-citations) own the wrapping forms.

Run it before publishing.
That run is the gate: the backlink posts the moment the item is created, and nothing withdraws it.
Fork CI re-runs it on pull-request bodies as a backstop, which reports a fired backlink rather than prevents one.

What the guard deliberately does not cover:

| Gap                              | Detail                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Issue bodies and comments        | No CI backstop. Only the pre-publication run covers them                                                          |
| Titles                           | Never scanned. Confirming whether a title backlinks would mean posting upstream                                   |
| A pull request off `hyprws`      | Never reaches the fork CI workflow                                                                                |
| Every bare number                | Reported even when it names a fork item. The guard has no network, so it reads the ambiguity as upstream          |
| `<pre>`, `<style>`, `<textarea>` | Read as ending at the next blank line, not the closing tag. Errs toward reporting                                 |
| Link and image text              | Not excluded, so a linked reference is reported although GitHub links only the destination. Errs toward reporting |

The reader is an approximation, not a CommonMark parser.
Every rule was checked both ways against GitHub's renderer, but an untried shape can still pair across a boundary it does not know.

## Desktop artifacts

| Command                                                   | Output                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `vp run dist:desktop:artifact --platform --target --arch` | One artifact for that triple                         |
| `vp run dist:desktop:dmg`                                 | macOS `.dmg` into `./release`, host arch by default  |
| `vp run dist:desktop:linux`                               | Linux AppImage into `./release`                      |
| `vp run dist:desktop:win`                                 | Windows NSIS installer; `:arm64` and `:x64` variants |

Unsigned local builds need no credentials.
`--signed` needs the platform's signing configuration below.

### Toolchain prerequisites

Packaging compiles the Rust resource monitor, and on Linux the libsecret browser import helper.
The artifact script probes every capability by compiling tiny programs, so it also catches libraries installed without headers.
`T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true` skips the Rust checks, because the build compiles no monitor.

| Host           | Install                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| Debian, Ubuntu | `cargo rustc build-essential libsecret-1-dev pkg-config imagemagick`                                           |
| Fedora         | `rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick`                                   |
| Arch           | `rust base-devel libsecret pkgconf imagemagick`                                                                |
| macOS          | `xcode-select --install`, then Rust from [rustup.rs](https://rustup.rs)                                        |
| Windows        | Rust, Python 3, VS Build Tools: **Desktop development with C++**, Windows SDK 10 or 11, MSVC Spectre libraries |

Add the Rust target matching the artifact: `rustup target add aarch64-apple-darwin`, `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`.
The Linux helper exits 2 for a missing key, 3 for denied or locked access, 4 for other keyring failures, and the importer preserves the distinction.

### Signing

| Platform | Needs                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------- |
| macOS    | `T3CODE_APPLE_TEAM_ID`, `T3CODE_MACOS_PROVISIONING_PROFILE`                                        |
| Windows  | Azure Trusted Signing `AZURE_*` endpoint, account, profile, publisher, plus service-principal auth |

The passkey RP domain derives from `T3CODE_CLERK_PUBLISHABLE_KEY` unless `T3CODE_CLERK_PASSKEY_RP_DOMAINS` overrides it.

### Packaging notes

| Topic        | Note                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| Icon         | `assets/prod/black-macos-1024.png` is the production source                   |
| Chrome       | Follows the release channel; the SVG rasterizes in the staging directory      |
| Window       | The Finder window is 540×412 over a 540×380 background; 32px is the title bar |
| App URL      | Production loads `t3code://app/`, never a loopback document URL               |
| Backend      | Includes `apps/server/dist`, started on loopback with an auth token           |
| First launch | On macOS a tester can right-click the app and choose **Open**                 |
| Staging      | `--keep-stage` keeps package contents for debugging                           |

## Browser development

`dev` and `dev:web` leave `VITE_HTTP_URL` and `VITE_WS_URL` unset, so the browser resolves the backend from `window.location.origin`.
Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`, so one bundle works from localhost or a tailnet hostname.

## Running multiple dev instances

Default ports are server `13773` and web `5733`; a shifted port is `base + offset`.

```bash
T3CODE_DEV_INSTANCE=branch-a vp run dev:desktop
```

| #   | Source                | Rule                                          |
| --- | --------------------- | --------------------------------------------- |
| 1   | `T3CODE_PORT_OFFSET`  | Non-negative integer; negatives are rejected  |
| 2   | `T3CODE_DEV_INSTANCE` | All-digit used directly, anything else hashed |
| 3   | Worktree path         | Hashed into an offset                         |

| Mode                 | Scans       | Shifts                     |
| -------------------- | ----------- | -------------------------- |
| `dev:web`            | Web port    | Web offset only            |
| `dev:server`         | Server port | Server offset only         |
| `dev`, `dev:desktop` | Both        | Both, as one shared offset |

An explicit server or dev-URL override removes that port from the check.
Treat the `[dev-runner]` output as authoritative.
