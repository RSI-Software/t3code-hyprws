# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

This is the agent-driven loop that keeps the fork trunk `hyprws` current and shipped.
[Fork development](../internals/fork-development.md) owns the fork's rules; this page owns the
invariants a sync must not break, what the orientation output means, failure handling, and the
one-time repository setup.

Run it through the repo-local [`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill, whose five
gates stop for orientation, rehearsal, focused checks, human sanity, and human-only apply. The skill
and its references hold every gate command; this page repeats none, so no step has two spellings.
Commit each rehearsal record under [`docs/operations/fork-sync-records/`](./fork-sync-records/).

`.agents/skills/fork-sync/` is the skill's only copy. `.claude/skills` is a tracked symlink to
`.agents/skills`, so a Claude-scope load and the link above resolve to the same file; edit the
`.agents` path.

## Invariants

These hold whichever gate is running. A gate that cannot satisfy one stops.

- **Rebase, never merge.** `hyprws` is rebased onto upstream history. Merging `upstream/main` into it
  buries the patch stack under merge commits.
- **The target is a stable upstream tag.** `vX.Y.Z`, never an untagged commit and never a nightly:
  the apply gate refuses anything else. When the fork needs a fix upstream has merged but not
  released, trial it in a worktree and take the stable tag that carries it.
- **A sync runs from the fork checkout, never the `main` checkout.** `main` only mirrors upstream.
- **The rewrite happens on `rehearse/<tag>`.** The rehearsal branch is created from `origin/hyprws`
  and is disposable; nothing rebases the `hyprws` worktree in place. That worktree does not need to be
  clean, and no gate requires it.
- **`origin/main` matches `upstream/main` before a sync starts.** The preflight fetches both lanes and
  refuses on a stale mirror, so orientation is never read against a lagging copy of upstream.
- **`origin/hyprws` is fetched during the run that reads it.** Every lease is captured from the
  published head this run proved, not from whatever an earlier unrelated fetch left behind.
- **`git config rerere.enabled` is `true`.** A resolved conflict replays on the next sync.
- **No fork commit is skipped, squashed, reordered, or reworded.** A commit upstream has made obsolete
  is a `retire-candidate` for the human, resolved by exact subject in
  [Fork delta](../internals/fork-delta.md); `git rebase --skip` never makes that decision.
- **Verification is targeted.** `fork:delta --check`, a typecheck per touched package, and the tests
  beside every touched file. Fork CI owns the full suite; a repo-wide run hides which seam failed.
- **A rejected lease is evidence, never an inconvenience.** Read the commits that refused it and
  incorporate them; never `--force` and never silently refresh.
- **A fork release is `v<upstream version>-hyprws.<n>`.** `<upstream version>` is the `X.Y.Z` of the
  target tag. `<n>` counts up within that version and restarts at 1 when the version changes, so a
  fork-only change bumps `<n>` and a new upstream version restarts it. The workflow writes the exact
  upstream tag into the release body.
- **Only the release closes an `upstream-watch` issue.** It closes after the fork build that carries
  the fix exists and the behavior has been verified in it.

The preflight checks the checkable ones from live state and names each unmet one with its fix. The
gates run it first and refuse rather than reporting a failure after they acted, so a precondition is
never prose a reader is trusted to have satisfied.

## What the orientation means

Gate 1 prints target, source, shared base, mirror currency, feasibility, automerged overlap, retire
candidates, and an `upstream-watch` verdict per open issue. This section is what that output means.

### The main mirror

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

### The report behind the orientation

Orientation summarizes what `fork:rebase-report` derives. Run the report itself when you want the full
detail on disk.

The generated Markdown under `docs/internals/generated/` is the human and agent orientation.
Its adjacent JSON file is the same versioned data for later automation.
Both record the resolved source, live upstream target, shared base, every intervening release tag,
commit groups, change-type totals, and read-only rebase feasibility.
The `Feasibility:` line names how many upstream first-parent commits remain clean, while the detailed
section identifies the first conflicting upstream commit, each conflict's introducing fork commit and
trailers, and overlapping files that Git automerged. Treat the first conflict as the fast-forward
boundary: the fork stack can advance automatically only through the preceding commit. Automerged
overlap is still a semantic review surface, not proof that the fork behavior remains valid.
They contain no wall-clock timestamp, so unchanged refs reproduce identical files.

The report embeds the `origin/hyprws` head, so a committed copy is stale after every landed commit.
The directory is gitignored; regenerate it rather than reading an older copy.

The same workflow then uploads a fresh pair as a seven-day artifact and prints the Markdown as the
run summary. `fork:rebase-report:artifact` keeps each immutable run under
`.dump/runs/fork-rebase-report/<run-id>/`. That artifact is a preview for readers without a checkout,
never the input a gate reads.

### Re-read what waits on upstream

Every fork issue labelled `upstream-watch` waits on an upstream issue or pull request, and orienting is
where each one is re-read. Gate 1 sweeps twice: against `upstream/main` before the tag pick, and
against the tag it orients on.

The two sweeps answer different questions and can disagree. A fix merged after the tag is `ready`
against `upstream/main` and `pending-tag` against the tag, so only the tag-targeted sweep describes
what a release built from that tag contains. Keep its output; the release gate closes from that sweep
alone.

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

| Verdict       | Meaning                                                                                         | Action                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ready`       | The merge commit is contained in the target.                                                    | The fix rides this rebase. Keep the watch open and close it at the release.   |
| `pending-tag` | Merged upstream, but not in the target.                                                         | Take a newer tag when the fix is worth it, or leave the issue open.           |
| `waiting`     | The upstream item is still open.                                                                | Leave it. Trial the pull request in a worktree when the fork needs it sooner. |
| `dropped`     | Upstream will not fix it: the pull request closed unmerged, or the issue closed as not planned. | Decide the fork's own fix and drop the label.                                 |
| `fix-uncited` | The upstream issue closed as completed and no fix is cited.                                     | Find the pull request that closed it and add it to the body as a code span.   |
| `unresolved`  | The merge commit is not in the local object store.                                              | Re-run after the preflight's upstream fetch.                                  |
| `uncited`     | The body cites no upstream item.                                                                | Nothing can resolve it; add the citation as a code span or drop the label.    |

The `upstream-triage` skill applies the label whenever it decides the fork waits on upstream.

Orientation decides which watches ride the rebase; it never closes one.
`ready` proves only that the target contains the merge commit, and the target is upstream code that no
fork release has shipped yet. A watch closes at the release, where the build that carries the fix
exists and the behavior can be verified in it.

## The release

The tag push starts `hyprws-release.yml`: checks, a Linux x64 AppImage build, then a GitHub release.
The release is never a prerelease, because the desktop updater ignores prereleases.

The release must list the `.AppImage` and `latest-linux.yml` assets. An installed fork build updates
from that release, because the build derives its feed from the building repository.

## Failure handling

- **`fork:delta --check` fails.**
  _A commit lost or never had a trailer; amend it in place with an interactive rebase before publishing._
- **The build fails on a runner tool.**
  _See the runner prerequisites below; the fix is a workflow step or an operator install, never a source change._
- **The lease is rejected.**
  _`origin/hyprws` moved; read the new commits and rehearse them in before pushing again, never `--force`._
- **A fork commit no longer applies.**
  _Rebuild it at the new seam, or record it as a retire candidate for the human; the decision is keyed by exact subject in [Fork delta](../internals/fork-delta.md)._
- **The apply gate refuses.**
  _An unmet precondition, a missing record, a stale `expected_old`, or an absent human sanity mark; fix the named cause and re-run the gate, never the push it guards._

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
