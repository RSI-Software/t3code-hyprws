# Upstream search recipes

Every command here reads. None of them writes to `pingdotgg/t3code`.

`git fetch upstream --tags` is the one command that writes, and it writes only locally: it updates this clone's `upstream/*` remote-tracking refs, its tags, and `FETCH_HEAD`. That is what reading upstream history costs, and it is load-bearing, because `git tag --contains` and `git log upstream/main` answer out of local refs and a stale fetch answers wrong. It sends nothing to `pingdotgg/t3code`.

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

A multi-word phrase in front of a qualifier needs its own quotes. `--search "github issue in:title"` matches nothing; `--search '"github issue" in:title'` matches.

## Sweep a whole domain

A survey reads the same surfaces as a hunt, but sweeps each one instead of stopping at the first canonical match. Run every block below, then run them again for each remaining phrase. A surface that returns nothing is a result the report states, not a block it omits.

Bind the scope once, so every surface honors the same window and the report header can name it:

```bash
REPO=pingdotgg/t3code
LIMIT=30
PHRASE='source control'         # rerun every block once per selected phrase
DOMAIN_PATHS=(apps/server/src/sourceControl apps/web/src/lib/openPullRequestLink.ts)

git fetch upstream --tags       # local refs and tags only; see the note at the top
SINCE=$(git log -1 --date=short --format=%cd "$(git merge-base HEAD upstream/main)")
```

`SINCE` is derived, never typed. It is the date of the commit the fork branched from upstream, which makes the window exactly the upstream work a rebase would bring in, makes two agents on the same fork head pick the same window, and moves the window forward at each rebase instead of letting it grow without bound. Run against `hyprws` at `badae6a5cc83` it answers `2026-08-25`, the day before `v0.0.34` published. A survey that deliberately wants more history — a domain nobody has swept before — may set `SINCE` by hand, and then the header says the window was widened on purpose and names the derived date it was widened from.

`SINCE` filters on last activity, not creation: an old thread upstream touched inside the window is news, and one it has not touched since before the window is not. Take `DOMAIN_PATHS` from that domain's rebase scan in [Fork delta](../../../../docs/internals/fork-delta.md), so the sweep covers the seams the fork actually sits on. The header may only claim the window every block below enforced, and only the surfaces that actually ran.

Widen the candidate search, keep both states, and window it:

```bash
gh search issues "$PHRASE" --repo "$REPO" --updated ">=$SINCE" --limit "$LIMIT" \
  --json number,title,state,createdAt,updatedAt

gh search prs "$PHRASE" --repo "$REPO" --updated ">=$SINCE" --limit "$LIMIT" \
  --json number,title,state,createdAt,updatedAt,url
```

`gh search` reports no match total, so a full page is the only truncation signal it gives. When either command returns exactly `LIMIT` rows, raise `LIMIT` and rerun until it does not, and record the limit you settled on in the report's `Gaps`. `source control` at `--limit 30` returns 30 issues and 30 pull requests, and both are truncated.

Requests live in Discussions, not in issues. Search them over GraphQL, and ask for the total and the page info so a truncated sweep is visible:

```bash
gh api graphql -f q="repo:$REPO $PHRASE updated:>=$SINCE" -f query='
  query($q: String!) {
    search(query: $q, type: DISCUSSION, first: 25) {
      discussionCount
      pageInfo { hasNextPage endCursor }
      nodes { ... on Discussion {
        number title category { name }
        createdAt updatedAt closed stateReason upvoteCount
      } }
    }
  }'
```

`discussionCount` is how many threads matched and `hasNextPage` says whether this page held them all. When it is `true`, page again with `after: $endCursor` or record the shortfall in `Gaps`; without those two fields a truncated sweep looks exactly like a complete one. Both `-f` flags belong to a GraphQL `query` — one carries the document, the other a variable — which is the one `gh api` shape allowed to send parameters without an explicit `--method GET`.

The categories are `Ideas`, `Q&A`, and `Announcements`. An open `Ideas` thread is a request; it is never a commitment, however many upvotes it carries. Discussion search ranks loosely and returns off-domain threads, so read every title and drop the ones that do not belong before they reach the report.

Read what the stable releases inside the window actually shipped. A tag list is metadata; the release body is the changelog, and it names pull requests no phrase search surfaced:

```bash
RELEASE_LIMIT=40
RELEASES=$(gh release list --repo "$REPO" --exclude-pre-releases --exclude-drafts \
  --limit "$RELEASE_LIMIT" --json tagName,publishedAt \
  -q '.[] | "\(.tagName) \(.publishedAt[0:10])"')

# The page is newest first, so it can only have dropped releases older than its last row.
printf '%s\n' "$RELEASES" | awk -v since="$SINCE" -v cap="$RELEASE_LIMIT" '
  {rows++; oldest=$2}
  END { if (rows == cap && oldest >= since)
          print "release sweep truncated inside the window" }'

printf '%s\n' "$RELEASES" | awk -v since="$SINCE" '$2 >= since {print $1}' |
while read -r tag; do
  gh release view "$tag" --repo "$REPO" --json body -q '.body' |
    grep -i -- "$PHRASE" | sed "s|^|$tag |"
done | sort -u
```

Both halves of that check have to hold, and a full page on its own proves nothing. Upstream has 45 releases that survive `--exclude-pre-releases`, so `--limit 40` comes back with exactly 40 rows on every survey while its oldest row, `v0.0.0-alpha.9` from `2026-03-03`, sits far outside any derived window. The sweep only lost work when the page is full **and** its oldest row is still inside the window, because that is the case where in-window releases fell off the end while the report claimed the surface was swept. Raise `RELEASE_LIMIT` and rerun until one half stops holding, and record the limit you settled on. If no reachable limit clears it, the release surface could not honor the window: narrow the header and put it in `Gaps`, under the rule the skill already gives for a surface that could not honor the window.

Every hit arrives already carrying the first stable tag that shipped it, which is the rebase target the fork issue would otherwise have to derive. `--exclude-pre-releases` drops the nightlies, which republish the same commits under a prerelease tag; leaving them in reports the same work twice, under a tag that is not the first stable one. It drops only what GitHub flagged, which is why `v0.0.0-alpha.9` survives it: those releases predate `pingdotgg/t3code#344`, the pull request that taught the release workflow to mark a suffixed version as a prerelease. Nothing that old reaches a derived window, so the date filter is what keeps them out of the report.

Read the domain's own code history over the same window:

```bash
git fetch upstream --tags
git log upstream/main --since="$SINCE" --no-merges \
  --pretty='%h %ad %s' --date=short -- "${DOMAIN_PATHS[@]}"
```

Squash subjects end in `(#NNNN)`, which turns each commit into a pull request to read. This is the surface that finds work no phrase matched.

## Fix the freshness boundary

Stable releases only; nightlies and alphas are noise:

```bash
gh release list --repo pingdotgg/t3code --exclude-pre-releases --exclude-drafts \
  --limit 5 --json tagName,publishedAt
```

The upstream release the fork currently sits on:

```bash
git fetch upstream --tags
git tag --contains "$(git merge-base HEAD upstream/main)" --sort=v:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
```

That `grep` is the stable-tag shape. [Turn a merged fix into a rebase target](#turn-a-merged-fix-into-a-rebase-target) explains why it is written that way.

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
git tag --contains <merge-commit-sha> --sort=v:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
```

One filter does all the work, because a stable upstream release tag is exactly `v<major>.<minor>.<patch>` with nothing after the patch number. Anchoring on that shape drops three kinds of wrong answer in one pass: upstream's non-version tags such as `desktop-preview`, which `--sort=v:refname` otherwise sorts to the front; upstream's prereleases, `v0.0.4-alpha.1` and every `v0.0.35-nightly.20260827.1202`; and the fork's own tags like `v0.0.34-hyprws.4`, which are not upstream releases at all.

Excluding prereleases is not tidiness. GitHub marks them `isPrerelease: true`, so a prerelease is never the first stable tag, and a recipe that answers one reports a release carrying the fix when no release carries it yet. `--list 'v*'` with a `grep -v -e nightly -e hyprws` admits them: run against `b74c7a79abbfbb7f6e8c5c4affb20784cea2b11c`, the merge commit of `pingdotgg/t3code#344`, it answers `v0.0.4-alpha.1`, where the first stable tag containing that commit is `v0.0.5`.

That first stable tag is the rebase target to name on the fork issue. When nothing comes back, no stable release carries the fix yet; upstream tags nightlies continuously, so check those before calling it unshipped:

```bash
git tag --contains <merge-commit-sha> --sort=v:refname | grep nightly | head -1
```

A nightly is the one prerelease the fork may rebase onto, and only as the deliberate exception [Fork development](../../../../docs/internals/fork-development.md) allows: name it as the rebase target only when the symptom blocks work before the next stable release, and say on the fork issue that the target is a nightly rather than a release. When neither line answers, the fix merged after every existing tag.

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
