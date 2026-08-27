# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

This is the agent-driven loop that keeps the fork trunk `hyprws` current and shipped.
[Fork development](../internals/fork-development.md) owns the rules; this page owns the steps.

Run it from the `hyprws` worktree, never from the `main` checkout.
Every step is scriptable; the only human inputs are conflict decisions and a refused lease.

## Step 0: Orient the rebase

Fetch both lanes, confirm the `main` mirror is current, and generate the orientation report from live refs:

```bash
git fetch upstream --tags
git fetch origin
git rev-parse origin/main upstream/main
vp run fork:rebase-report
```

The `hyprws rebase report` workflow fast-forwards `origin/main` to `upstream/main` on every `hyprws`
push, on a schedule, and on manual dispatch, so the two shas normally match.
If they differ, upstream moved since the last run; dispatch the workflow or push the mirror yourself
with `git push origin upstream/main:main`.

The mirror job pushes with the `HYPRWS_MIRROR_TOKEN` repository secret, a fine-grained personal
access token scoped to this repository with Contents and Workflows read/write. Upstream commits
touch `.github/workflows`, which the default Actions token may never push. A run whose mirror job
fails with a missing-secret error needs the secret recreated; a rejected push means `main` diverged
and wants a human, never a force.
That push is a fast-forward because nothing else ever writes `main`.
If it is rejected, someone committed to `main`; stop and inspect before forcing anything.

The generated Markdown under `docs/internals/generated/` is the human and agent orientation.
Its adjacent JSON file is the same versioned data for later automation.
Both record the resolved source, live upstream target, shared base, every intervening release tag,
commit groups, change-type totals, and read-only rebase feasibility.
The `Feasibility:` line names how many upstream first-parent commits remain clean, while the detailed
section identifies the first conflicting upstream commit, each conflict's introducing fork commit and
trailers, and overlapping files that Git automerged. Treat the first conflict as the fast-forward
boundary: the fork stack can advance automatically only through the preceding commit. Automerged
overlap is still a semantic review surface, not proof that the fork behavior remains valid.
Use `--target vX.Y.Z` to inspect a specific release instead of the live upstream tip.
They contain no wall-clock timestamp, so unchanged refs reproduce identical files.

The report embeds the `origin/hyprws` head, so a committed copy is stale after every landed commit.
The directory is gitignored; regenerate it here rather than reading an older copy.

The same workflow then uploads a fresh pair as a seven-day artifact and prints the Markdown as the
run summary. That artifact is a preview for readers without a checkout, not the rebase input; Step 0 is.

Download and validate a run when you need one:

```bash
vp run fork:rebase-report:artifact
```

The command keeps each immutable run under `.dump/runs/fork-rebase-report/<run-id>/`. Use
`--run <id>` to inspect a particular manual or scheduled run.

### Re-read what waits on upstream

Every fork issue labelled `upstream-watch` waits on an upstream issue or pull request, and orienting is
where each one is re-read. Sweep them before you pick a target, then again against the tag you picked:

```bash
vp run fork:upstream-watch                  # against upstream/main, to pick a target
vp run fork:upstream-watch --target vX.Y.Z  # against the tag you picked
```

The two sweeps answer different questions and can disagree. A fix merged after the tag is `ready`
against `upstream/main` and `pending-tag` against the tag, so only the tag-targeted sweep describes
what a release built from that tag contains. Keep its output; [Step 5](#step-5-tag-and-release) closes
from that sweep alone.

The sweep lists every open `upstream-watch` issue and, for each upstream item its body cites, whether
that item is merged and whether its merge commit is contained in the target. It pages the full open
set rather than capping it, re-walks a multi-page set until two walks agree so an issue closing mid-walk
cannot hide one behind the cursor, and fails loudly rather than reporting a list it had to truncate. It proves
the label exists before it reports an empty sweep, so `No open upstream-watch issues` is evidence and
not the shape of a renamed label. It reads
GitHub and Git and writes nothing. It recognizes a citation only inside a code span, so the sweep
itself can never fire a cross-reference on an upstream thread.

A verdict is per citation; the issue takes the least advanced verdict among the citations that can
still advance. `dropped` and `fix-uncited` are spent, so a watch that also cites the merged fix still
reaches `ready`.

| Verdict       | Meaning                                                                                         | Action                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ready`       | The merge commit is contained in the target.                                                    | The fix rides this rebase. Keep the watch open and close it at [Step 5](#step-5-tag-and-release). |
| `pending-tag` | Merged upstream, but not in the target.                                                         | Take a newer tag when the fix is worth it, or leave the issue open.                               |
| `waiting`     | The upstream item is still open.                                                                | Leave it. Trial the pull request in a worktree when the fork needs it sooner.                     |
| `dropped`     | Upstream will not fix it: the pull request closed unmerged, or the issue closed as not planned. | Decide the fork's own fix and drop the label.                                                     |
| `fix-uncited` | The upstream issue closed as completed and no fix is cited.                                     | Find the pull request that closed it and add it to the body as a code span.                       |
| `unresolved`  | The merge commit is not in the local object store.                                              | Re-run after `git fetch upstream --tags`.                                                         |
| `uncited`     | The body cites no upstream item.                                                                | Nothing can resolve it; add the citation as a code span or drop the label.                        |

The `upstream-triage` skill applies the label whenever it decides the fork waits on upstream.

This step decides which watches ride the rebase; it never closes one.
`ready` proves only that the target contains the merge commit, and the target is upstream code that no
fork release has shipped yet. A watch closes at [Step 5](#step-5-tag-and-release), where the release
that carries the fix exists and the behavior can be verified in it.

## Preconditions

- `upstream` points at `pingdotgg/t3code` and `origin` at `RSI-Software/t3code-hyprws`.
- The `hyprws` worktree is clean and `vp run fork:delta --check` passes before you start.
- `git config rerere.enabled` is `true`, so a resolved conflict replays on the next sync.
- The one-time setup below has been completed.

## Step 1: Pick the target

Rebase onto an upstream tag, never onto an untagged commit.

```bash
git tag --list 'v*' --sort=-v:refname | grep -v nightly | head -n 3
git tag --list 'v*-nightly*' --sort=-v:refname | head -n 3
```

Take the newest stable `vX.Y.Z` by default.
Take the newest nightly when the fork needs an upstream fix that has not reached a stable release.
Nightlies are tagged from `upstream/main` several times a day, so the tip is rarely far from one.

## Step 2: Rebase

```bash
expected_old=$(git rev-parse origin/hyprws)
git rebase vX.Y.Z
```

Resolve conflicts with the [conflict policy](../internals/fork-development.md#conflict-policy).
Read the upstream change first, then reapply the smallest fork behavior on the new seam.

A rerere replay is a candidate, not a resolution; review every reused hunk.
When upstream has made a fork commit obsolete, drop it with `git rebase --skip` and say so in the next commit.

## Step 3: Scan and verify

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

## Step 4: Publish with a lease

```bash
git push --force-with-lease=refs/heads/hyprws:"$expected_old" origin HEAD:hyprws
```

A rejected lease means `origin/hyprws` moved during the sync.
Fetch and read the new commits, rebase them onto the new stack, then push with a lease captured after that read.

Never refresh the lease without reading what it refused.

## Step 5: Tag and release

A fork release is `v<upstream version>-hyprws.<n>`.
`<upstream version>` is the `X.Y.Z` of the tag from step 1, nightly suffix dropped.
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

### Close what the release shipped

Every watch that [Step 0](#step-0-orient-the-rebase)'s **tag-targeted** sweep called `ready` is now in
a published fork build. That sweep, `vp run fork:upstream-watch --target <the tag this release builds>`,
is the only candidate set. Do not close from the `upstream/main` sweep beside it: a fix merged after the
tag is `ready` there and `pending-tag` against the tag, so that set can name a merge this release does
not carry. Re-run the tag-targeted sweep if you no longer have its output.

Install or run the build, verify the reported behavior is actually fixed, and close the issue naming
the upstream merge commit and this fork release. A watch whose behavior is still broken stays open with
what you saw; the upstream fix landing is not the same claim as the fork working.

This is the only step that closes an `upstream-watch` issue.

## Failure handling

- **`fork:delta --check` fails.**
  _A commit lost or never had a trailer; amend it in place with an interactive rebase before publishing._
- **The build fails on a runner tool.**
  _See the runner prerequisites below; the fix is a workflow step or an operator install, never a source change._
- **The lease is rejected.**
  _Step 4 covers it; do not use `--force`._
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

`hyprws-ci.yml`, `hyprws-release.yml`, and `hyprws-rebase-report.yml` are the only workflows that stay enabled.

### Merge settings

Landing onto `hyprws` is squash-only, so the stack stays linear.
The squash subject and body come from the pull-request title and body, so the body ends with the trailer block; see the fork guide's landing section.

```bash
gh repo edit RSI-Software/t3code-hyprws \
  --enable-squash-merge --enable-rebase-merge=false --enable-merge-commit=false \
  --delete-branch-on-merge
gh api -X PATCH repos/RSI-Software/t3code-hyprws \
  -f squash_merge_commit_title=COMMIT_OR_PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES
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
