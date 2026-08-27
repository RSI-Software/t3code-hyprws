# Upstream search recipes

Every command here reads. None of them writes to `pingdotgg/t3code`.

Preconditions: `gh auth status` is healthy, and the `upstream` remote points at `pingdotgg/t3code`.

## Find candidates

Search issues and pull requests separately; `gh search issues` excludes pull requests unless asked.

```bash
gh search issues "files panel" --repo pingdotgg/t3code --limit 10 \
  --json number,title,state,createdAt,url

gh search prs "workspace files" --repo pingdotgg/t3code --limit 10 \
  --json number,title,state,createdAt,url
```

`--state` accepts only `open` or `closed`; omit it to see both.

The list commands take a full search qualifier string and do accept `--state all`, which makes them the better tool for a title-and-body sweep:

```bash
gh issue list --repo pingdotgg/t3code --state all --limit 10 \
  --search "files panel cached in:title,body" \
  --json number,title,state,createdAt

gh pr list --repo pingdotgg/t3code --state all --limit 10 \
  --search "apps/web/src/components/files in:title,body" \
  --json number,title,state,mergedAt
```

## Resolve the canonical item

The timeline of the best issue match names the pull requests that claim it and the duplicates folded into it. Run it before trusting a phrase search.

```bash
gh api repos/pingdotgg/t3code/issues/5779/timeline --paginate \
  -q '.[] | select(.event=="cross-referenced")
      | {n: .source.issue.number,
         t: .source.issue.title,
         pr: (.source.issue.pull_request != null),
         state: .source.issue.state}'
```

A duplicate points at its canonical issue through its state reason:

```bash
gh issue view 5866 --repo pingdotgg/t3code \
  --json number,title,state,stateReason,closedAt
```

Fork issues can appear in that timeline. That is a cross-reference the fork leaked, not upstream activity; cite in code spans so the next one does not fire.

## Read state and dates

```bash
gh pr view 4379 --repo pingdotgg/t3code \
  --json number,title,state,isDraft,createdAt,updatedAt,mergedAt,mergeCommit,mergeable \
  -q '{n:.number, t:.title, state:.state, draft:.isDraft,
       created:.createdAt, updated:.updatedAt,
       merged:.mergedAt, sha:.mergeCommit.oid, mergeable:.mergeable}'
```

`state: "CLOSED"` with `merged: null` is a pull request closed without merging.

## Turn a merged fix into a rebase target

```bash
git fetch upstream --tags
git tag --contains <merge-commit-sha> --sort=v:refname | grep -v nightly | head -1
```

That first stable tag is the rebase target to name on the fork issue. When nothing comes back, no stable release carries the fix yet; upstream tags nightlies continuously, so check those before calling it unshipped:

```bash
git tag --contains <merge-commit-sha> --sort=v:refname | grep nightly | head -1
```

Name that nightly as the rebase target only when the symptom blocks work before the next stable release. When neither line answers, the fix merged after every existing tag.

To see whether the fork already carries it:

```bash
git merge-base --is-ancestor <merge-commit-sha> HEAD && echo "already in this fork branch"
```

## Trial a pending pull request

Use a worktree of its own. `gh pr checkout` rewrites whatever worktree it runs in, so the "never on `hyprws`" rule has to be an assertion, not an assumption about the previous line having worked.

Worktrunk creates through `wt switch --create`; there is no `wt new`. Directory switching needs the shell integration, which an agent shell does not have, so create with `--no-cd` and resolve the path yourself.

```bash
PR=<pr-number>
TRIAL_BRANCH="upstream-trial-$PR"

wt switch --create "$TRIAL_BRANCH" --base hyprws --no-cd

TRIAL_PATH=$(wt list --format=json |
  jq -r --arg b "$TRIAL_BRANCH" '.items[] | select(.branch == $b) | .worktree.path')
[ -n "$TRIAL_PATH" ] || { echo "no trial worktree; do not check out here"; exit 1; }

cd "$TRIAL_PATH"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$TRIAL_BRANCH" ] ||
  { echo "not on the trial branch; refusing to check out a pull request"; exit 1; }

gh pr checkout "$PR" --repo pingdotgg/t3code --branch "$TRIAL_BRANCH" --force
git rebase hyprws
```

`--force` is what lets the checkout reset the branch Worktrunk just created; without it `gh` refuses an existing branch. Every command in this block is local or a read against upstream.

Remove the worktree with `wt remove` when the verdict is recorded.

Then verify narrowly and stop:

- Run the tests the pull request touches, plus a typecheck of the packages it changes. No repo-wide checks.
- Reproduce the original symptom on the trial build, and confirm the reverse case the fork actually cares about.
- Record an adopt, adapt, or reject verdict on the fork issue.

The trial branch stays local. It is never pushed to `pingdotgg/t3code`, and anything worth telling upstream becomes a saved suggestion for the human.
