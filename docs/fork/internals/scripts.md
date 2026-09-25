# Scripts

> For maintainers. Using T3 Code? See [docs/user](../user/).

`package.json` lists every script and what it runs.
This file holds only what a script name cannot carry.

## First checkout

T3 Code uses [Vite+](https://viteplus.dev/guide/).
Node 24 is required; Bun is optional, and the server picks Bun adapters only when it detects Bun.

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

`vp run dev` prints a one-time pairing URL; open it so the first navigation is authenticated.
Runner flags follow the root task name: `vp run dev --home-dir /tmp/t3code-dev`.
`--browser` auto-opens a browser and is off by default; the runner owns `T3CODE_NO_BROWSER`, so setting it yourself does nothing.

## Dev app surfaces

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

### Dev state directories

| Where you run it    | State                                               |
| ------------------- | --------------------------------------------------- |
| Linked git worktree | `<worktree>/.t3/userdata`, outranking `T3CODE_HOME` |
| Main checkout       | `~/.t3/dev`                                         |
| `--home-dir <path>` | `<path>/userdata`                                   |

Submodules are not worktrees and keep the normal precedence.

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

## Desktop build prerequisites

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

Unsigned local builds need no credentials.
`--signed` needs the platform's signing configuration.

| Platform | Needs                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------- |
| macOS    | `T3CODE_APPLE_TEAM_ID`, `T3CODE_MACOS_PROVISIONING_PROFILE`                                        |
| Windows  | Azure Trusted Signing `AZURE_*` endpoint, account, profile, publisher, plus service-principal auth |

The passkey RP domain derives from `T3CODE_CLERK_PUBLISHABLE_KEY` unless `T3CODE_CLERK_PASSKEY_RP_DOMAINS` overrides it.

## Thread CLI

`vp run thread` lets an agent drive a thread on a running server over its WebSocket RPC.
`--help` owns the commands, output, and exit codes.
It needs a bearer session token in a file (`--token-file`) or `$T3_TOKEN`.

Issue one on the server host with the product's own auth CLI:

```bash
# Packaged Linux install
T3=~/.local/opt/t3-code/current
ELECTRON_RUN_AS_NODE=1 T3CODE_HOME=~/.t3 "$T3/t3code" \
  "$T3/resources/app.asar/apps/server/dist/bin.mjs" \
  auth session issue --label NAME --ttl 1h --json
```

| Concern    | Detail                                               |
| ---------- | ---------------------------------------------------- |
| AppImage   | Same form, run from its `/tmp/.mount_T3-*/` mount    |
| Output     | JSON after startup log lines: `token`, `sessionId`   |
| Scopes     | Administrative; keep the file private and gitignored |
| Revoke     | `... auth session revoke SESSION_ID`                 |
| Revocation | Rejects new requests at once; open sockets stay up   |

## Upstream reference guard

`vp run fork:upstream-refs <file>` scans a body file for a live upstream reference; a missing path fails.
Fenced blocks, code spans, and HTML comments are ignored; anything left live exits 1.
A bare `#4379` is a finding too, because GitHub resolves it against `pingdotgg/t3code` and the guard cannot tell offline which numbers the fork holds.
An upstream URL naming no item is not a finding.
[Upstream citations](./fork-development.md#upstream-citations) own the wrapping forms.

Run it before publishing.
That run is the gate: the backlink posts the moment the item is created, and nothing withdraws it.
Fork CI re-runs it on pull-request bodies as a backstop, which reports a fired backlink rather than prevents one.

What the guard deliberately does not cover:

| Gap                          | Detail                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Issue bodies and comments    | No CI backstop. Only the pre-publication run covers them                                                          |
| Titles                       | Never scanned. Confirming whether a title backlinks would mean posting upstream                                   |
| A pull request off `hyprws`  | Never reaches the fork CI workflow                                                                                |
| Every bare number            | Reported even when it names a fork item. The guard has no network, so it reads the ambiguity as upstream          |
| Link and image text          | Not excluded, so a linked reference is reported although GitHub links only the destination. Errs toward reporting |
| Indented code, quoted fences | Not masked, so a citation there is reported although GitHub renders it as code. Errs toward reporting             |

The reader masks three shapes: HTML comments, fences, and code spans.
A citation in any other shape GitHub renders as code is reported anyway.
