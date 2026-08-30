# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

The `hyprws upstream sync` workflow is the normal upstream-sync operator. It mirrors upstream, finds
the newest upstream release tag the fork can reach without a textual conflict, verifies a replay of
the complete fork stack, and publishes the result according to the configured mode. A maintainer
intervenes only to resolve a reported block, enable trunk rewrites, or cut a stable release.

[Fork development](../internals/fork-development.md) owns the repository discipline. The repo-local
[`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill owns the gated human sign-off procedures
for unblocking a rebase and cutting a stable release.

## Model

`hyprws` is the single fork trunk. Its upstream base is the newest stable or nightly upstream tag at
or before the rebase report's conflict-free boundary; when stable and nightly tags point at the same
position, stable wins the tie. The bot never merges upstream into the fork and never drops, squashes,
reorders, or rewords a fork commit.

On each scheduled, pushed, or manually dispatched run, the workflow:

1. fast-forwards the fork's `main` mirror to `upstream/main`;
2. generates the feasibility report and finds the newest clean upstream release tag;
3. snapshots any newly crossed stable upstream tag on a create-only release branch;
4. replays and verifies the whole fork stack on the selected tag;
5. publishes the candidate or rewrites `hyprws`, according to `HYPRWS_AUTO_REBASE`; and
6. creates or updates stable-candidate and `rebase-blocked` issues.

A run that has no newer clean release tag is a successful no-op. A conflict beyond the clean target
does not prevent the bot from advancing to that target; the same run reports the next block for a
human. Every `rebase-blocked` issue files under conflict-handling tracker
RSI-Software/t3code-hyprws#217.

## Bot-owned refs

Do not create, move, delete, or force-push these refs by hand:

| Ref                     | Meaning                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| `hyprws-previous`       | The pre-rewrite `hyprws` head saved by the bot before an automatic trunk rewrite. |
| `hyprws-next`           | The verified candidate stack published while the repository is in candidate mode. |
| `release/vX.Y.Z-hyprws` | A create-only snapshot of the fork stack on upstream stable `vX.Y.Z`.             |

A release snapshot never follows later trunk work. It is the immutable branch from which a human
chooses a stable fork tag. If a manual leased apply lands the trunk on a stable upstream tag, the
next sync run snapshots that exact trunk head unless the snapshot or a published stable already
exists.

## Auto-rebase modes

The repository variable `HYPRWS_AUTO_REBASE` accepts three values. An unset variable means
`candidate`.

| Value       | Behaviour                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `off`       | Mirror and report only. No candidate or trunk ref is rewritten; blocked issues are still upserted or closed.        |
| `candidate` | Publish the verified stack to `hyprws-next`; still create stable snapshots and issues, but do not rewrite `hyprws`. |
| `on`        | Save the old trunk as `hyprws-previous`, then rewrite `hyprws` with an explicit expected-old lease.                 |

In `on` mode, a landing that triggers a rebase produces two nightlies by design: one for the landed
commit and one for the bot-pushed rebased head.

The repository intentionally starts in candidate mode. After reading a successful candidate run and
preparing local lanes for recovery, enable automatic trunk rewrites with:

```bash
gh variable set HYPRWS_AUTO_REBASE --body on -R RSI-Software/t3code-hyprws
```

To return to report-only or candidate operation, set the same variable to `off` or `candidate`.
Deleting it also restores the candidate default.

## One-time repository setup

### Bot token

Create a fine-grained personal access token owned by the automation actor, limited to
`RSI-Software/t3code-hyprws`, with these repository permissions:

- **Contents: Read and write** — mirror, candidate, snapshot, and leased trunk pushes;
- **Workflows: Read and write** — mirrored upstream commits can change workflow files.

Store it as the `HYPRWS_MIRROR_TOKEN` Actions secret. The command prompts for the token value:

```bash
gh secret set HYPRWS_MIRROR_TOKEN -R RSI-Software/t3code-hyprws
```

The workflow uses its normal `GITHUB_TOKEN` with `issues: write` for labels and issues. Do not widen
the personal access token for issue management.

### Labels

The workflow force-creates `rebase-blocked` on every run. Its `--force` flag overwrites a drifted
description with the workflow-owned text:

```bash
gh label create rebase-blocked --force --color B60205 \
  --description "The fork stack conflicts with newer upstream history" \
  -R RSI-Software/t3code-hyprws
```

The `release` label must already exist before the first stable snapshot, because the workflow does
not create it. This repository already has it; verify that it remains available:

```bash
gh label view release -R RSI-Software/t3code-hyprws
```

### Upstream workflows and merge settings

Keep only `hyprws-ci.yml`, `hyprws-release.yml`, and `hyprws-upstream-sync.yml` enabled. Upstream
workflows remain in the tree unchanged but disabled, because they expect upstream secrets and
runners.

```bash
gh workflow list --all --repo RSI-Software/t3code-hyprws
for workflow in ci.yml release.yml pr-size.yml pr-vouch.yml web-preview.yml deploy-relay.yml \
  publish-aur.yml issue-labels.yml thread-transfer-report.yml mobile-eas-preview.yml \
  mobile-eas-production.yml mobile-fingerprint-check.yml mobile-showcase-screenshots.yml; do
  gh workflow disable "$workflow" --repo RSI-Software/t3code-hyprws
done

gh repo edit RSI-Software/t3code-hyprws \
  --enable-squash-merge --enable-rebase-merge=false --enable-merge-commit=false \
  --delete-branch-on-merge
gh api -X PATCH repos/RSI-Software/t3code-hyprws \
  -f squash_merge_commit_title=COMMIT_OR_PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES
```

### Applied rulesets

The rulesets tracked in RSI-Software/t3code-hyprws#220 are applied manually in
**Settings → Rules → Rulesets** and are all `active`. This repository does not apply or change them
unattended:

- **`hyprws`:** targets `refs/heads/hyprws`; requires a pull request with 0 approvals and the status
  checks `Check`, `Test`, `Test Server 1`, `Test Server 2`, and `Test Server 3`; repository
  administrators have an always-allow bypass. The bot pushes with the administrator's PAT and must
  force-push after a rebase, so this ruleset deliberately has no force-push rule.
- **`main`:** targets `refs/heads/main`; requires a pull request and has the same always-allow
  repository-administrator bypass. Only the mirror job writes this branch.
- **`no trunk deletion`:** targets `refs/heads/hyprws` and `refs/heads/main`; blocks deletion and has
  no bypass actors, so it binds administrators and the bot too.
- **`stable tags`:** targets `refs/tags/v*-hyprws.*` and excludes `refs/tags/v*-hyprws-nightly.*`;
  blocks deletion and updates and has no bypass actors.

A direct non-bypass push to `hyprws` cannot be demonstrated because the repository has no non-admin
collaborator, so the pull-request rule is documented as admin-only until one exists.

The fork CI checks the pull-request body for squash-commit ledger trailers only on a ready pull
request whose base branch is `hyprws`. It skips drafts and every non-`hyprws` base, including
rebase-rehearsal branches, because those rehearsals land by a leased force-push rather than a squash
merge.

### Runners

Both fork workflows run on `ubuntu-latest`.
`hyprws-release.yml` publishes a nightly on every landing on `hyprws`; its six-hour schedule is a
fallback that publishes only when the head differs from the newest nightly tag. The release job
keeps the newest 7 nightlies and deletes older releases with their tags; stable releases are never
pruned.
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

## Reading a bot run

Open the latest `hyprws upstream sync` run and read the **Auto-rebase** job summary, not only the
green or red conclusion:

```bash
repo=RSI-Software/t3code-hyprws
gh run list --workflow hyprws-upstream-sync.yml --limit 5 -R "$repo"
run_id="$(gh run list --workflow hyprws-upstream-sync.yml --limit 1 \
  -R "$repo" --json databaseId --jq '.[0].databaseId')"
test -n "$run_id"
gh run view "$run_id" -R "$repo"
gh run view "$run_id" -R "$repo" --json url --jq .url
```

The summary emits exactly these top-level fields: mode, status, old head, base, target, rebased head,
and stable-candidate count. Status is `off`, `no-op`, or `advanced`. When a block remains, a
**Blocked beyond the clean window** block adds the first conflicting upstream commit, remaining
upstream commit count, and newest later tag.

The replay still verifies commit count and messages, the fork ledger, `vp check`, and typecheck
before any push, but the summary does not itemise those checks. The conflict table and affected fork
commits live in the `rebase-blocked` issue body, not in the run summary. If the run fails, inspect its
failed step separately:

```bash
gh run view "$run_id" --log-failed -R "$repo"
```

In candidate mode, compare the summary's **Rebased head** with the published ref:

```bash
git fetch origin hyprws-next
git rev-parse origin/hyprws-next
```

A green run with a `rebase-blocked` issue means the bot advanced as far as it safely could and then
reported the next human task. It does not mean the entire upstream lane was clean.

## Unblocking a `rebase-blocked` issue

Open the single current blocked issue and read the blocking upstream commit, affected fork commits,
domains, files, and newest upstream tag beyond the block:

```bash
repo=RSI-Software/t3code-hyprws
blocked_issue="$(gh issue list --state open --label rebase-blocked -R "$repo" \
  --json number --jq 'if length == 1 then .[0].number else error("expected one open rebase-blocked issue") end')"
gh issue view "$blocked_issue" --comments -R "$repo"
```

Then invoke the [`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill at its **unblock** entry
point. The maintainer chooses the newest upstream stable or nightly tag past the reported block. The
agent rehearses the complete stack on `rehearse/<tag>`, preserves upstream intent while resolving
each conflict, runs the fork scan and focused checks, and presents every decision row, silent seam,
and grounding claim at the sign-off boundary. The human records the decisions, grounding approval,
login/date, and explicit go; missing sign-off is a hard stop. The agent copies that sign-off into the
record and ledger, commits it, and runs the gate without bypassing any refusal.

After the gate passes, the agent runs the final trunk push with the `expected_old` read exactly once
at the start of the same rehearsal:

```bash
git push --force-with-lease=refs/heads/hyprws:"$expected_old" origin HEAD:hyprws
```

Never move a bot-owned ref as part of the unblock. After the leased push succeeds, the agent posts
the resolved blocking SHA and target tag, quoting the human sign-off; that comment records the
signed-off resolution. The push starts a new bot run. That run automatically closes every open
`rebase-blocked` issue when no block remains, or updates the open issue when a later conflict remains. A stale lease is never refreshed:
rehearse again, repeat the checks and sign-off, and then apply with the new rehearsal's lease.

## Cut a stable release

The bot opens one `release` issue per create-only stable snapshot. Start by listing those issues and
choose the issue number for the version to release:

```bash
gh issue list --state open --label release \
  -R RSI-Software/t3code-hyprws
```

Set `issue` to a number from that list. Derive the bot-owned snapshot, fetch it, and create a
disposable worktree from the exact remote branch:

```bash
issue=<number>
repo=RSI-Software/t3code-hyprws
candidate="$(gh issue view "$issue" -R "$repo" --json title --jq '.title | capture("^Stable candidate (?<name>v[0-9]+\\.[0-9]+\\.[0-9]+-hyprws)$").name')"
release_branch="release/$candidate"
upstream_version="${candidate#v}"
upstream_version="${upstream_version%-hyprws}"

git fetch --tags origin \
  "refs/heads/$release_branch:refs/remotes/origin/$release_branch"
candidate_sha="$(git rev-parse "origin/$release_branch^{commit}")"
wt switch --create "cut/$candidate" --base "origin/$release_branch"
# Worktrunk has no path subcommand; copy the absolute path it prints above.
worktree_path=<path printed by Worktrunk>
cd "$worktree_path"
```

Verify the snapshot and derive the next tag. These repo-wide checks are an explicit stable-release
gate exception to the targeted-check rule: they match the release workflow preflight before the
sign-off boundary.

```bash
test "$(git rev-parse HEAD)" = "$candidate_sha"
vp i
vp run fork:delta --check
vp check
vp run typecheck
vp run test

last_n="$(git tag --list "v${upstream_version}-hyprws.*" \
  | sed -n "s/^v${upstream_version//./\\.}-hyprws\\.\([0-9][0-9]*\)$/\1/p" \
  | sort -n | tail -n 1)"
release_n="$(( ${last_n:-0} + 1 ))"
release_tag="v${upstream_version}-hyprws.${release_n}"

git fetch --no-tags origin \
  "refs/heads/$release_branch:refs/remotes/origin/$release_branch"
test "$(git rev-parse "origin/$release_branch^{commit}")" = "$candidate_sha"

git ls-remote --exit-code --tags origin "refs/tags/$release_tag" \
  && { echo "refusing to replace existing tag $release_tag" >&2; false; }
```

**Sign-off boundary.** The agent presents the selected issue, source snapshot and SHA, derived tag,
prior tags, and check results. The human records the exact candidate and an explicit go. Missing
sign-off is a hard stop. After sign-off, the agent creates the annotated tag at the verified snapshot
SHA and pushes it create-only:

```bash
git tag -a "$release_tag" "$candidate_sha" \
  -m "T3 Code hyprws ${release_tag#v}"
git push origin "refs/tags/$release_tag"
```

After the tag push, return to the original checkout and let Worktrunk trash the disposable worktree
and delete its tagged `cut/*` branch. Never remove the directory with `rm`:

```bash
cd -
wt remove -D "cut/$candidate"
```

The tag push starts the stable channel of `hyprws-release.yml`. The agent finds that exact run,
watches it, and verifies the published release contains an `.AppImage` and `latest-linux.yml`:

```bash
run_id=
for attempt in $(seq 1 12); do
  run_id="$(gh run list --workflow hyprws-release.yml --event push --limit 20 \
    -R "$repo" --json databaseId,headBranch \
    --jq "map(select(.headBranch == \"$release_tag\"))[0].databaseId // empty")"
  test -n "$run_id" && break
  sleep 5
done
test -n "$run_id"
gh run watch "$run_id" -R "$repo"
assets="$(gh release view "$release_tag" -R "$repo" --json assets \
  --jq '.assets[].name')"
printf '%s\n' "$assets"
grep -Eq '\.AppImage$' <<<"$assets"
grep -Fxq 'latest-linux.yml' <<<"$assets"
run_url="$(gh run view "$run_id" -R "$repo" --json url --jq .url)"
gh issue close "$issue" -R "$repo" --comment \
  "Released \`$release_tag\` from \`$release_branch@$candidate_sha\`. Workflow: $run_url"
```

The issue close, immutable tag, workflow run, and GitHub release are the stable-cut record. Do not
add a human sync record for an ordinary bot snapshot. An `upstream-watch` issue closes only after the
released build carrying its fix has been installed or run and the behaviour verified.

## Recovering local lanes after a rewrite

Feature lanes must start from `hyprws`, never from `hyprws-next` or a bot-owned `release/*` snapshot.
`hyprws-next` is an inspection ref: after the mode flips from candidate to on, it remains at the last
candidate push and goes stale. Release snapshots are immutable release inputs, not development bases.

`hyprws-previous` does not exist until the first on-mode run. For that first rewrite, copy the full
old head from the **Auto-rebase** run summary and use it as the old boundary:

```bash
git fetch origin hyprws
git rebase --onto origin/hyprws <old-head> <feature-branch>
```

After an on-mode run has published `hyprws-previous`, a feature branch based on the immediately
previous trunk can use the bot-owned ref directly:

```bash
git fetch origin hyprws hyprws-previous
git rebase --onto origin/hyprws origin/hyprws-previous <feature-branch>
```

Replace `<old-head>` with the summary's full old-head SHA and `<feature-branch>` with the branch
printed by `git branch --show-current` in that feature worktree. Inspect the range first if the lane
was not based on that old boundary; do not guess an `--onto` boundary. A lane mistakenly based on
`hyprws-next` or `release/*` needs its actual merge base inspected and cannot use the generic recovery
command safely.

The canonical `hyprws` worktree carries no independent commits. Reset it to the published trunk:

```bash
git fetch origin hyprws
git reset --hard origin/hyprws
```

Never run the hard reset in a feature worktree or a checkout with uncommitted work.

## Failure handling

- **Mirror fails:** recreate `HYPRWS_MIRROR_TOKEN` when the secret is missing or expired. A rejected
  fast-forward means someone wrote to `main`; inspect it and never force the mirror.
- **No clean target:** the run is report-only until an upstream release tag enters the clean window.
  Do not target an untagged commit.
- **Feasibility said clean but replay conflicts:** treat it as an automation bug. The bot aborts the
  rebase and pushes nothing; do not resolve inside the workflow worktree.
- **Replay verification fails:** the bot pushes nothing. Read the failed check and fix the fork or
  automation through a pull request; never weaken the commit-message or ledger comparison.
- **The `hyprws` lease is rejected:** remote work appeared after the bot read the old head. Inspect
  the new commits and rerun from them; never replace the explicit lease with `--force` or silently
  refresh it.
- **A stable snapshot already exists:** it is immutable. Inspect the existing branch and issue; do
  not force-update it. A corrected candidate needs an explicit maintainer decision and a new record.
- **A blocked issue remains:** use the skill's unblock entry point. A clean automerge is still a
  semantic review surface, and a fork commit is retired only by a recorded human decision.
- **Stable release fails:** leave the candidate issue open, fix the workflow or runner, and rerun the
  failed release. Do not move or replace the tag after a release has been published.

## Version ordering caveat

Semver precedence is global even though the updater separates channels. For example,
`0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2`. That does not promote a nightly
to stable: the desktop update-channel resolver keeps fork nightlies on the nightly feed and stable
fork releases on the stable feed. Do not infer channel or release recency from one mixed semver sort;
filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
