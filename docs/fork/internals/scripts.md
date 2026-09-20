# Scripts

> For maintainers. Using T3 Code? See [docs/user](../user/).

## First checkout

T3 Code uses [Vite+](https://viteplus.dev/guide/).
Node 24 required; Bun optional, auto-detected.

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

`vp run dev` prints a one-time pairing URL; open it to authenticate.

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
`--browser` is off by default; the runner owns `T3CODE_NO_BROWSER`.

### Worktree setup

| Step       | Behavior                                  |
| ---------- | ----------------------------------------- |
| **Deps**   | frozen lockfile, cache warmed             |
| **Links**  | `.env`, `infra/relay/.env` from canonical |
| **Rerun**  | replaces stale symlinks only              |
| **Never**  | overwrites a regular file                 |
| **Absent** | dangling link, live once the file exists  |

### Dev app surfaces

`vp run dev:app [--external|--preview|--desktop]` uses this checkout's isolated `.t3` home.

| Flag        | Use                                                                       |
| ----------- | ------------------------------------------------------------------------- |
| default     | External browser                                                          |
| `--preview` | Native agents: wait for the ready URL, pass it to `preview_open`          |
| `--desktop` | DevTools off, profile in `.t3/electron`, records CDP, takes `--workspace` |

| Topic          | Behavior                                                 |
| -------------- | -------------------------------------------------------- |
| **Switching**  | stop the owned run first                                 |
| **State**      | fixtures, threads, auth persist                          |
| **Dev Web**    | refuses remote, relay, SSH terminals                     |
| **Cold build** | preview listener held 10 minutes                         |
| **Spent link** | `node apps/server/src/bin.ts pair --base-dir "$PWD/.t3"` |

### Sharing over the tailnet

`vp run dev --share` publishes the web port over tailnet HTTPS and pairs against it.

| Topic             | Behavior                                  |
| ----------------- | ----------------------------------------- |
| **Exit**          | mapping removed                           |
| **Default**       | `T3CODE_BUNDLED_DEV=1`, saves round trips |
| **Web entry**     | dynamic import only                       |
| **Static import** | breaks once routes split                  |

### Desktop agent instance

| Aspect        | Behavior                                   |
| ------------- | ------------------------------------------ |
| **DevTools**  | detached DevTools off                      |
| **CDP**       | stable free port from 9223                 |
| **Endpoint**  | recorded under `XDG_STATE_HOME`            |
| **Placement** | compositor's by default                    |
| **Override**  | `T3CODE_DESKTOP_AGENT_WORKSPACE` in `.env` |
| **Per run**   | `--workspace <selector>`; `none` resets    |

### Dev state directories

| Where you run it    | State                                               |
| ------------------- | --------------------------------------------------- |
| Linked git worktree | `<worktree>/.t3/userdata`, outranking `T3CODE_HOME` |
| Main checkout       | `~/.t3/dev`                                         |
| `--home-dir <path>` | `<path>/userdata`                                   |

Submodules keep the normal precedence.

## Build, check, test

| Command                | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `vp run build`         | Apps, packages, oxlint plugin, scripts         |
| `vp run build:desktop` | Desktop pipeline (desktop plus server)         |
| `vp run start`         | Production server, static built web app        |
| `vp check`             | Format, lint, types; types run separately here |
| `vp run typecheck`     | Strict TypeScript for all packages             |
| `vp run test`          | Workspace tests                                |
| `vp run lint:mobile`   | Mobile native static analysis                  |

`node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path>` inspects or seeds an isolated database, backing up on write.

## Fork scripts

The [fork-sync runbook](../operations/fork-sync.md) owns walk verbs, gate order, and release shape.
This is the entry-point index.

| Command                       | What it does                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `fork:delta`                  | Active fork commits by trailer; `--check` gates trailers and retired subjects |
| `fork:preflight`              | Proves rerere, remotes, fresh `origin/hyprws`, level `main`, deps             |
| `fork:lockfile`               | Lockfile records its manifests' specifiers                                    |
| `fork:orient`                 | Gate 1: target tag, feasibility, retire candidates, watch verdicts            |
| `fork:scan`                   | Every domain's rebase-scan table, plus ledger guards                          |
| `fork:retire-pass`            | Probes the fold worklist before the first fold                                |
| `fork:sync <verb>`            | Human unblock state machine, one external record                              |
| `fork:sync-gate`              | Guards the signed-off apply: tag plus record                                  |
| `fork:auto-rebase`            | Replays the stack onto the newest feasible tag                                |
| `fork:rebase-report`          | Gitignored snapshot under `docs/internals/generated/`                         |
| `fork:rebase-report:artifact` | Downloads and validates the latest artifact                                   |
| `fork:upstream-watch`         | Resolves items cited by open `upstream-watch` issues                          |
| `fork:upstream-refs`          | Refuses a live upstream reference before publishing                           |
| `fork-release-version.ts`     | Fork release metadata for the release workflow                                |

Notable refusals:

| Command                            | Refusal                                           |
| ---------------------------------- | ------------------------------------------------- |
| `fork:delta --check --squash-body` | Needs explicit `--base` and `--head`              |
| `fork:lockfile`                    | `importers` drift only; restores bytes on throw   |
| `fork:orient`                      | No deps needed; runs in a bare worktree           |
| `fork:scan --since`                | Adopted authoring guards fatal without `--strict` |
| `fork:sync-gate`                   | Needs a record resolving outside the repository   |
| `fork:upstream-watch`              | Fails rather than report a truncated sweep        |

### Upstream reference guard

Run `vp run fork:upstream-refs <file>` before publishing any body; stdin also works.
That run is the gate: a backlink fires on creation and never withdraws.
[Upstream citations](./fork-development.md#upstream-citations) own the wrapping forms.

| Rule              | Result                                         |
| ----------------- | ---------------------------------------------- |
| **Ignored**       | fences, code spans, HTML comments              |
| **Live ref**      | exits 1                                        |
| **Bare `#N`**     | finding; offline, fork and upstream look alike |
| **Item-less URL** | not a finding                                  |
| **Fork CI**       | backstop on PR bodies, reports only            |

Deliberate gaps:

| Gap                              | Detail                                      |
| -------------------------------- | ------------------------------------------- |
| Issue bodies and comments        | No CI backstop; pre-publication run only    |
| Titles                           | Never scanned; checking would post upstream |
| A pull request off `hyprws`      | Never reaches the fork CI workflow          |
| Every bare number                | Reported even when it names a fork item     |
| `<pre>`, `<style>`, `<textarea>` | End at the next blank line, not the tag     |
| Link and image text              | Not excluded; link text is reported too     |

The reader approximates; it is not a CommonMark parser.

## Desktop artifacts

| Command                                                   | Output                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `vp run dist:desktop:artifact --platform --target --arch` | One artifact for that triple                         |
| `vp run dist:desktop:dmg`                                 | macOS `.dmg` into `./release`, host arch by default  |
| `vp run dist:desktop:linux`                               | Linux AppImage into `./release`                      |
| `vp run dist:desktop:win`                                 | Windows NSIS installer; `:arm64` and `:x64` variants |

Unsigned local builds need no credentials; `--signed` needs the configuration below.

### Toolchain prerequisites

| Topic        | Behavior                                     |
| ------------ | -------------------------------------------- |
| **Compiles** | Rust resource monitor                        |
| **Linux**    | plus libsecret import helper                 |
| **Probe**    | tiny programs, catches missing headers       |
| **Skip**     | `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true` |

| Host           | Install                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| Debian, Ubuntu | `cargo rustc build-essential libsecret-1-dev pkg-config imagemagick`                                           |
| Fedora         | `rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick`                                   |
| Arch           | `rust base-devel libsecret pkgconf imagemagick`                                                                |
| macOS          | `xcode-select --install`, then Rust from [rustup.rs](https://rustup.rs)                                        |
| Windows        | Rust, Python 3, VS Build Tools: **Desktop development with C++**, Windows SDK 10 or 11, MSVC Spectre libraries |

Add the matching Rust target: `rustup target add aarch64-apple-darwin`, `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`.

Linux helper exit codes, preserved by the importer:

| Code | Meaning                 |
| ---- | ----------------------- |
| 2    | missing key             |
| 3    | denied or locked access |
| 4    | other keyring failure   |

### Signing

| Platform | Needs                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------- |
| macOS    | `T3CODE_APPLE_TEAM_ID`, `T3CODE_MACOS_PROVISIONING_PROFILE`                                        |
| Windows  | Azure Trusted Signing `AZURE_*` endpoint, account, profile, publisher, plus service-principal auth |

Passkey RP domain derives from `T3CODE_CLERK_PUBLISHABLE_KEY`, overridden by `T3CODE_CLERK_PASSKEY_RP_DOMAINS`.

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

`dev` and `dev:web` leave `VITE_HTTP_URL` and `VITE_WS_URL` unset, so the browser uses `window.location.origin`.
Vite proxies `/api`, `/ws`, `/oauth`, `/.well-known`, so one bundle serves localhost and tailnet alike.

## Running multiple dev instances

Default ports: server `13773`, web `5733`. Shifted port is `base + offset`.

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

An explicit server or dev-URL override drops that port from the check.
`[dev-runner]` output is authoritative.
