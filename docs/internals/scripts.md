# Scripts

> For maintainers. Using T3 Code? See [docs/user](../user/).

## First checkout

T3 Code uses [Vite+](https://viteplus.dev/guide/). Install the global `vp` command, install
dependencies, then start the dev stack:

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

Node 24 is required. Bun is not: the server picks Bun adapters when it detects Bun and falls back to
Node otherwise, and nothing in contributor setup needs it.

`vp run dev` prints a one-time pairing URL. Open it so the first browser navigation is
authenticated.

## Dev

- `vp run dev`: Starts contracts, server, and web in watch mode.
- `vp run dev --share`: Also publishes the web port over HTTPS on this machine's tailnet. The
  startup pairing URL is built against the shared origin, and the mapping is removed on exit.
  Shared runs default to Vite's bundled dev mode (`T3CODE_BUNDLED_DEV=1`): a remote browser pays a
  network round trip per import level in unbundled dev, which turns a cold module graph into
  minutes of waterfall. Set `T3CODE_BUNDLED_DEV=0` to opt a shared run back out.
- `vp run dev --browser`: Auto-opens a browser. Off by default. The dev runner writes
  `T3CODE_NO_BROWSER` itself from this flag, so setting `T3CODE_NO_BROWSER=0` in your environment has
  no effect; use `--browser`.
- `vp run dev:server`: Starts just the server. It runs on Node (`node --watch src/bin.ts`), so
  without Bun present it selects `NodePtyAdapter` and `NodeHttpServer`.
- `vp run dev:web`: Starts just the Vite dev server for the web app.
- `vp run dev:desktop`: Starts the Electron shell against the dev server.
- `vp run dev:desktop:agent`: Starts or restarts this worktree's desktop dev stack, disables detached DevTools, allocates a stable free CDP port from base 9223, and records the live endpoint under `XDG_STATE_HOME`. It uses normal compositor placement by default. Set `T3CODE_DESKTOP_AGENT_WORKSPACE=-1` in the repo's gitignored `.env` to map without focus one numbered workspace before the invoking app, or set a positive workspace ID for fixed placement. `--workspace <selector>` overrides the repo setting for one run; `none` explicitly restores default placement.
- `vp run dev:desktop:agent:url`: Prints the live worktree instance's recorded CDP origin.
- `vp run hypr:workspace [-t <seconds>]`: Captures the active app's Hyprland workspace, optionally waits so the user can switch workspaces, then reports both the newly focused workspace and the app's original workspace.
- `vp run dev:marketing`: Starts the Astro marketing site.
- Pass dev-runner flags directly after the root task name, for example:
  `vp run dev --home-dir /tmp/t3code-dev`

### Dev state directories

- Dev commands run from a linked **git worktree** default to that worktree's gitignored `.t3`, even
  when `T3CODE_HOME` is set, storing state in `<worktree>/.t3/userdata`. Pass `--home-dir <path>` to
  choose another isolated directory explicitly. Submodules are not worktrees and keep the normal
  precedence.
- From the **main checkout**, dev commands implicitly use `~/.t3/dev`, keeping development state
  separate from `~/.t3/userdata`. An explicit `--home-dir <path>` stores state under
  `<path>/userdata`; the base directory remains available for caches, worktrees, and other shared
  data.

## Build, check, test

- `vp run build`: Fans out over `apps/*`, `packages/*`, `oxlint-plugin-t3code`, and `scripts`.
  Workspaces that define a build task run one: desktop, marketing, server (which depends on web), and
  web. Shared packages are consumed and bundled transitively rather than built separately.
- `vp run build:desktop`: Builds the desktop pipeline (desktop plus server).
- `vp run start`: Runs the production server (serves the built web app as static files).
- `vp check`: Vite+ format, lint, and type checks. This repo sets `typeCheck: false` in its lint
  options, so workspace type checking runs separately.
- `vp run typecheck`: Strict TypeScript checks for all packages.
- `vp run test`: Runs workspace tests.
- `vp run lint:mobile`: Mobile native static analysis (`scripts/mobile-native-static-check.ts`).
- `node scripts/fork-release-version.ts --channel <stable|nightly>`: Resolves fork release metadata
  for `.github/workflows/hyprws-release.yml`. Stable requires `--tag vX.Y.Z-hyprws.N`. Nightly
  requires `--date YYYYMMDD --run-number N --sha SHA`, derives the next patch through the shared
  nightly-version helpers, and emits `X.Y.Z-hyprws-nightly.YYYYMMDD.N`. Both channels select the
  previous tag from their own fork tag family for generated release notes. `--github-output`
  appends the version, tag, name, previous tag, and GitHub release flags to `GITHUB_OUTPUT`;
  otherwise it prints the same metadata.
- `vp run fork:delta`: Lists active fork commits above `upstream/main` by `Fork-Domain` and
  `Fork-Tier` trailer (`scripts/fork-delta.ts`), omitting subjects recorded under Retired in the fork
  ledger. `--check` exits 1 when a commit has invalid trailers or a retired subject is still present;
  `--json` emits the active ledger for tooling. `--domain <name> --shas` prints one domain's SHAs in
  stack order for `git cherry-pick` onto upstream. `--check --squash-body <file>` verifies a
  pull-request body ends with the trailer block its squash commit will inherit.
- `vp run fork:preflight`: Checks the preconditions the fork-sync gates depend on and names each
  unmet one (`scripts/fork-preflight.ts`): `rerere.enabled`, the `origin` and `upstream` remotes, a
  freshly fetched `origin/hyprws`, a `main` mirror level with `upstream/main`, and installed
  dependencies. It fetches rather than trusting whatever the last unrelated fetch left behind, and
  exits 1 with every unmet precondition and its fix. Gates call it first and refuse on a failure, so
  a stale ref is named before a gate acts on it rather than after.
- `vp run fork:orient --target vX.Y.Z`: Gate 1 of the fork-sync flow (`scripts/fork-orient.ts`). It
  runs `fork:preflight`, proves the target exists as a tag and is reachable from `upstream/main` with
  `git merge-base --is-ancestor`, then prints target, source, shared base, mirror currency,
  feasibility, automerged overlap, retire candidates, an `upstream-watch` verdict per open issue
  against that tag, and the Gate 1 Stop block to stdout. It writes no file, ref, or GitHub thread. It
  imports only Node builtins and its sibling scripts, so `node scripts/fork-orient.ts` runs in a
  worktree with no dependencies installed; installed dependencies are reported, not required. It
  exits 1 when a Gate 1 precondition is unmet, the tag is unproved, or the watch sweep fails.
- `vp run fork:scan`: Checks every fork domain's `### Rebase scan` table in the fork ledger
  (`scripts/fork-scan.ts`). It groups the fork stack by `Fork-Domain`, intersects the files those
  commits change with the files upstream changed over the same base, and exits 1 naming each domain
  and file the domain's scan table does not list. `--target <ref>` picks the upstream ref to compare
  against (default `upstream/main`), `--head <ref>` the fork ref, and `--base <ref>` overrides their
  merge base. `vp run fork:scan --head origin/hyprws --target vX.Y.Z` is the gate 3 overlap walk.
- `vp run fork:auto-rebase --fetch --mode candidate`: Reads the rebase feasibility window directly,
  selects its newest upstream stable or nightly tag, and replays the complete fork stack in a
  detached temporary worktree (`scripts/fork-auto-rebase.ts`). It snapshots each intermediate stable
  tag to a create-only `release/vX.Y.Z-hyprws` branch. Candidate mode force-updates `hyprws-next`;
  `on` also records `hyprws-previous` and rewrites `hyprws` with an explicit expected-old lease;
  a rejected lease restores both the prior recovery ref and snapshots created by that run. `off`
  reports without mutating refs. Verification reuses the checkout install only when the target leaves
  every workspace manifest and `pnpm-lock.yaml` unchanged; otherwise it runs `vp i` in the detached
  worktree. `--dry-run` performs the selection, rebase, and verification without any push. `--target`
  accepts only an upstream release tag inside the clean window. The workflow consumes `--summary`,
  `--issue-json`, and `--github-output` for its run summary and fork-local issues.
- `vp run fork:sync-gate --tag vX.Y.Z`: Guards the signed-off agent apply step
  (`scripts/fork-sync-gate.ts`). Stable tags remain the default; `--allow-nightly` also accepts
  `vX.Y.Z-nightly.YYYYMMDD.N` for a deliberate nightly-target rehearsal. The gate refuses on any
  unmet preflight precondition and exits 1 unless the committed rehearsal record has a full
  `expected_old` equal to the `origin/hyprws` head the preflight fetched, plus a human sanity login
  and ISO date. It takes that head from the preflight rather than resolving the ref itself, so it
  cannot pass a lease against a ref nothing fetched. It only reports readiness; it never pushes,
  tags, or releases.
- `vp run fork:upstream-refs <file>`: Scans a fork issue, comment, or pull-request body for a live
  upstream reference (`scripts/fork-upstream-refs.ts`). Fenced blocks, code spans, and HTML comments
  are ignored; anything left live exits 1, one finding per line as
  `<line>:<column> <reference> (<label>)`, because GitHub would post a backlink on the
  `pingdotgg/t3code` thread. Reads stdin when no path is given. A bare `#4379` or `GH-4379` is a
  finding too: GitHub resolves a number this fork has never issued against the repository it was
  forked from, and the guard cannot tell offline which numbers the fork holds. Writing a fork
  reference as `RSI-Software/t3code-hyprws#108` clears it and still renders as `#108`. An upstream
  URL that names no item (`/issues/new`, `/pull/new/main`, `/discussions/categories/ideas`) is not a
  finding. See [Upstream citations](./fork-development.md#upstream-citations) for the wrapping forms.

  Run it against the body file before publishing. That run is the gate: GitHub posts the backlink
  the moment the issue, comment, or pull request is created, and nothing that reacts afterwards can
  withdraw it. Fork CI re-runs the guard on every pull-request body as a backstop, which reports a
  backlink that has already fired rather than preventing one.

  What the guard does not cover, deliberately:

  - Issue bodies and comments have no CI backstop. Only the pre-publication run covers them, so a
    landing tool that publishes without it leaves them unguarded.
  - Titles are never scanned. Whether a title creates a backlink is unverified, and confirming it
    would mean posting upstream.
  - A pull request that does not target `hyprws` never reaches `.github/workflows/hyprws-ci.yml`.
  - Every bare number is reported, including one that names a fork item. The guard has no network,
    so it cannot ask which numbers this fork holds, and it reads the ambiguity as upstream. Expect
    this on prose carried down from upstream: `docs/internals/t3-connect.md` cites `#5051` that way.
  - The Markdown reader is not a CommonMark parser. It masks fenced blocks, indented code, code
    spans, HTML comments, and blockquote containers, and it splits inline pairing on blank lines,
    ATX and setext headings, thematic breaks, list starts, deeper blockquotes, GFM table cells, and
    the HTML blocks that may interrupt a paragraph. Each rule above was checked in both directions
    against GitHub's own Markdown renderer. What remains:

    - A `<pre>`, `<style>`, or `<textarea>` block is read as ending at the next blank line rather
      than at its closing tag, so a citation after that blank is reported although GitHub prints it
      literally. Errs toward reporting.
    - Link and image text is not excluded, so `[#107](…)` and `[pingdotgg/t3code#4379](…)` are
      reported although GitHub links only the destination. Errs toward reporting.

    No counter-example that errs the other way survived this round. The reader is still an
    approximation, so a shape nobody has tried can pair across a boundary it does not know.

- `vp run fork:rebase-report`: Generates the gitignored Markdown and schema-v3 JSON orientation
  snapshot under `docs/internals/generated/` from `origin/hyprws` to `upstream/main`
  (`scripts/fork-rebase-report.ts`). Its read-only feasibility section walks the upstream first-parent
  lane with `git merge-tree`, attributes each hard-conflict file and hunk count to its introducing fork
  commit/domain/tier, and lists overlapping files Git automerged for semantic review. Its Retire
  candidates section marks commits whose patch is already upstream or whose changed hunks overlap
  or sit adjacent to upstream hunks, and carries forward Retired/Kept decisions by commit subject from the fork
  ledger. Pass `--target vX.Y.Z` to inspect a release and `--fetch` to refresh both remotes first.
  `--check` performs a byte-for-byte comparison against the files on disk without writing, and a write
  run that produces those same bytes prints `unchanged:` instead of `updated:` and leaves the file
  alone. The `hyprws-upstream-sync.yml` run uploads a fresh pair on every `hyprws` push and on a
  schedule; the report is never committed because it embeds the fork head.
- `vp run fork:rebase-report:artifact`: Downloads and validates the latest successful workflow
  artifact under `.dump/runs/fork-rebase-report/<run-id>/`. Pass `--run <id>` to inspect a specific
  run. An existing run directory is reused because workflow artifacts are immutable.
- `vp run fork:upstream-watch`: Sweeps the fork's open `upstream-watch` issues and resolves each
  upstream item their bodies cite (`scripts/fork-upstream-watch.ts`). Per citation it reports whether
  the upstream pull request merged and whether its merge commit is contained in the rebase target, so
  the sync's orient step knows which watches ride the rebase. The issue list is paged to completeness
  and the sweep fails rather than reporting a truncated one, because a capped sweep is indistinguishable
  from a clean one. The endpoint pages by offset over a live set and offers no cursor, so a multi-page
  walk repeats until two walks see the same issue numbers; otherwise an issue that closes mid-walk
  slides a still-open one behind the cursor. A closed upstream issue is `fix-uncited` only when it
  closed as completed: a `not_planned` closure has no fixing pull request to find, so it is `dropped`.
  An issue takes the least advanced verdict among the citations that can still
  advance, so a spent citation never strands a watch whose fix has landed. Pass `--target vX.Y.Z` for a
  release and `--json` for tooling. It reads GitHub and Git only, and recognizes a citation only inside
  a code span, so it can never fire a cross-reference on an upstream thread.
- `node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...`: Inspects or seeds
  an isolated T3 SQLite database; writes create a private backup first.

## Desktop artifacts

- `vp run dist:desktop:artifact --platform <mac|linux|win> --target <target> --arch <arch>`: Builds a desktop artifact for a specific platform/target/arch.
- `vp run dist:desktop:dmg`: Builds a shareable macOS `.dmg` into `./release`. Architecture defaults
  to the host, so this produces an arm64 DMG on Apple Silicon. Use `dist:desktop:dmg:arm64` or
  `dist:desktop:dmg:x64`, or pass `--arch <arm64|x64|universal>`, to force one.
- `vp run dist:desktop:linux`: Builds a Linux AppImage into `./release`.
- `vp run dist:desktop:win`: Builds a Windows NSIS installer into `./release`. `:arm64` and `:x64`
  variants exist.

### Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/prod/black-macos-1024.png` as the production app icon source.
- The DMG chrome follows the release channel: neutral for Latest and the Nightly sky artwork for
  Nightly. Blueprint artwork remains exclusive to Dev builds. Packaging rasterizes the selected
  SVG into standard and Retina PNGs inside the disposable staging directory.
- The Finder window is 540×412 while its background is 540×380; the extra 32px accounts for the
  title bar included in Finder's window bounds.
- Desktop production windows load the bundled UI from the `t3code://app/` root URL (not a
  `127.0.0.1` document URL, and not an explicit `index.html` path).
- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an
  auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first
  launch.
- To keep staging files for debugging package contents, run: `vp run dist:desktop:dmg --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Signed macOS builds also require `T3CODE_APPLE_TEAM_ID` and
  `T3CODE_MACOS_PROVISIONING_PROFILE`. The passkey RP domain is derived from
  `T3CODE_CLERK_PUBLISHABLE_KEY` unless `T3CODE_CLERK_PASSKEY_RP_DOMAINS` overrides it.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Browser development

`dev` and `dev:web` leave `VITE_HTTP_URL` and `VITE_WS_URL` unset so the browser resolves the backend
from `window.location.origin`. Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the
server, allowing the same bundle to work from localhost or a tailnet hostname.

## Running multiple dev instances

Worktrees derive a preferred port offset from their path.

- Default ports: server `13773`, web `5733`
- Shifted ports: `base + offset`
- Example: `T3CODE_DEV_INSTANCE=branch-a vp run dev:desktop`

Offset resolution, in order:

1. `T3CODE_PORT_OFFSET`, which must be a non-negative integer. Negative values are rejected.
2. `T3CODE_DEV_INSTANCE`. An all-digit value is used directly as the offset; any other non-empty
   value is hashed into one.
3. The worktree path hash.

Collision scanning depends on the mode. `dev:web` scans only the web port and shifts only the web
offset. `dev:server` scans only the server port. `dev` and `dev:desktop` scan both and shift them
together as one shared offset. Explicit server or dev-URL overrides remove the corresponding port
from the availability check. Treat the `[dev-runner]` output as authoritative.
