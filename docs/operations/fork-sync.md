# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

This is the agent-driven loop that keeps the fork trunk `hyprws` current and shipped.
[Fork development](../internals/fork-development.md) owns the rules; this page owns the steps.

Run it from the `hyprws` worktree, never from the `main` checkout.
Every step is scriptable; the only human inputs are conflict decisions and a refused lease.

## Preconditions

- `upstream` points at `pingdotgg/t3code` and `origin` at `RSI-Software/t3code-hyprws`.
- The `hyprws` worktree is clean and `vp run fork:delta --check` passes before you start.
- `git config rerere.enabled` is `true`, so a resolved conflict replays on the next sync.
- The one-time setup below has been completed.

## Step 1: Mirror main

Fetch everything and fast-forward the `main` mirror.

```bash
git fetch upstream --tags
git fetch origin
git push origin upstream/main:main
```

The push is a fast-forward because nothing else ever writes `main`.
If it is rejected, someone committed to `main`; stop and inspect before forcing anything.

## Step 2: Pick the target

Rebase onto an upstream tag, never onto an untagged commit.

```bash
git tag --list 'v*' --sort=-v:refname | grep -v nightly | head -n 3
git tag --list 'v*-nightly*' --sort=-v:refname | head -n 3
```

Take the newest stable `vX.Y.Z` by default.
Take the newest nightly when the fork needs an upstream fix that has not reached a stable release.
Nightlies are tagged from `upstream/main` several times a day, so the tip is rarely far from one.

## Step 3: Rebase

```bash
expected_old=$(git rev-parse origin/hyprws)
git rebase vX.Y.Z
```

Resolve conflicts with the [conflict policy](../internals/fork-development.md#conflict-policy).
Read the upstream change first, then reapply the smallest fork behavior on the new seam.

A rerere replay is a candidate, not a resolution; review every reused hunk.
When upstream has made a fork commit obsolete, drop it with `git rebase --skip` and say so in the next commit.

## Step 4: Scan and verify

Walk the rebase scan for every active domain in [Fork delta](../internals/fork-delta.md).
A clean rebase is not evidence that a domain is still needed.

Then run what fork CI will run:

```bash
vp run fork:delta --check
vp check
vp run typecheck
vp run build:desktop
```

Run the tests for every package a conflict touched, with `vp run --filter <package> test`.
Fix forward with `git commit --fixup` and an autosquash rebase, so each fork commit stays self-contained.

## Step 5: Publish with a lease

```bash
git push --force-with-lease=refs/heads/hyprws:"$expected_old" origin HEAD:hyprws
```

A rejected lease means `origin/hyprws` moved during the sync.
Fetch and read the new commits, rebase them onto the new stack, then push with a lease captured after that read.

Never refresh the lease without reading what it refused.

## Step 6: Tag and release

A fork release is `v<upstream version>-hyprws.<n>`.
`<upstream version>` is the `X.Y.Z` of the tag from step 2, nightly suffix dropped.
`<n>` counts up within that version and restarts at 1 when the version changes.

A stack on `v0.0.34-nightly.20260823.1164` therefore releases as `v0.0.34-hyprws.1`.
The workflow writes the exact upstream tag into the release body.

```bash
git tag v0.0.34-hyprws.1
git push origin v0.0.34-hyprws.1
```

The tag starts `hyprws-release.yml`: checks, a Linux x64 AppImage build, then a GitHub release.
The release is never a prerelease, because the desktop updater ignores prereleases.

Watch it with `gh run watch` and verify the release lists the `.AppImage` and `latest-linux.yml`.
An installed fork build updates from that release, because the build derives its feed from the building repository.

Bump `<n>` for a fork-only change or a newer nightly on the same upstream version.
A new upstream version always restarts the suffix.

## Failure handling

- **`fork:delta --check` fails.**
  _A commit lost or never had a trailer; amend it in place with an interactive rebase before publishing._
- **The build fails on a runner tool.**
  _See the runner prerequisites below; the fix is a workflow step or an operator install, never a source change._
- **The lease is rejected.**
  _Step 5 covers it; do not use `--force`._
- **A fork commit no longer applies.**
  _Rebuild it at the new seam or drop it; record the decision in the commit or in Fork delta._

## One-time setup

These steps were run once when the fork trunk was created.
Rerun a step when its state drifts, for example after a rebase adds an upstream workflow.

### Upstream workflows

Upstream's workflows register on the default branch as soon as GitHub indexes it.
Every one of them targets Blacksmith runners or upstream secrets, so each is disabled, never edited or deleted.

```bash
gh workflow list --all --repo RSI-Software/t3code-hyprws
for workflow in ci.yml release.yml pr-size.yml pr-vouch.yml web-preview.yml deploy-relay.yml \
  publish-aur.yml issue-labels.yml thread-transfer-report.yml mobile-eas-preview.yml \
  mobile-eas-production.yml mobile-fingerprint-check.yml mobile-showcase-screenshots.yml; do
  gh workflow disable "$workflow" --repo RSI-Software/t3code-hyprws
done
```

`hyprws-ci.yml` and `hyprws-release.yml` are the only workflows that stay enabled.

### Merge settings

Landing onto `hyprws` is rebase-only, so the stack stays linear and keeps its trailers.

```bash
gh repo edit RSI-Software/t3code-hyprws \
  --enable-rebase-merge --enable-squash-merge=false --enable-merge-commit=false \
  --delete-branch-on-merge
```

### Runners

Both fork workflows run on `ubuntu-latest`.
GitHub-hosted runners are free for a public repository, and pull requests from outside the org cost nothing.

The rsi-ci pool was measured on 2026-08-23 and rejected.
Five concurrent jobs on one 12-core container reached wall times at parity with hosted at best.

Revisit only if the pool grows or the repository goes private.
The runbook `docs/runbooks/ci-runners.md` in `RSI-Software/ops` owns the pool.

Tools the workflows need beyond the hosted image:

| Tool             | How the workflow gets it                                          |
| ---------------- | ----------------------------------------------------------------- |
| Node and `vp`    | `voidzero-dev/setup-vp@v1` installs into the workspace cache.     |
| Rust and `cargo` | `dtolnay/rust-toolchain@stable` installs under the runner's home. |
| ImageMagick      | Present on the hosted image; `apt-get` when it is missing.        |

Treat a missing tool as a workflow task, not a reason to patch the build script.

### Optional T3 Connect config

The fork build leaves T3 Connect unconfigured unless these repository variables exist:

- `T3CODE_RELAY_URL`
- `T3CODE_CLERK_PUBLISHABLE_KEY`
- `T3CODE_CLERK_JWT_TEMPLATE`
- `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`

The workflow passes them through when set and leaves the feature dark when they are not.
