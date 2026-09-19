# Upstream search recipes

Every command here reads.
None of them writes to `pingdotgg/t3code`.

`git fetch upstream --tags` is the one that writes, and only locally: this clone's `upstream/*` refs, its tags, and `FETCH_HEAD`.
It is load-bearing, because `git tag --contains` and `git log upstream/main` answer out of local refs and a stale fetch answers wrong.

Preconditions: `gh auth status` is healthy, and `upstream` points at `pingdotgg/t3code`.

## Find candidates

Search issues and pull requests separately, because `gh search issues` excludes pull requests unless asked.

```bash
gh search issues "files panel" --repo pingdotgg/t3code --limit 10 \
  --json number,title,state,createdAt,url

gh search prs "workspace files" --repo pingdotgg/t3code --limit 10 \
  --json number,title,state,createdAt,url
```

`--state` accepts only `open` or `closed`; omit it to see both.

The list commands take a full qualifier string and do accept `--state all`, which makes them the better title-and-body sweep:

```bash
gh issue list --repo pingdotgg/t3code --state all --limit 10 \
  --search "files panel cached in:title,body" \
  --json number,title,state,createdAt

gh pr list --repo pingdotgg/t3code --state all --limit 10 \
  --search "apps/web/src/components/files in:title,body" \
  --json number,title,state,mergedAt
```

A multi-word phrase in front of a qualifier needs its own quotes.
`--search "github issue in:title"` matches nothing; `--search '"github issue" in:title'` matches.

## Sweep a whole domain

A survey reads the same surfaces as a hunt, but sweeps each one instead of stopping at the first match.
Run every block below, then run them again for each remaining phrase.
A surface that returns nothing is a result the report states, not a block it omits.

Bind the scope once, so every surface honors the same window:

```bash
REPO=pingdotgg/t3code
LIMIT=30
PHRASE='source control'         # rerun every block once per selected phrase
DOMAIN_PATHS=(apps/server/src/sourceControl apps/web/src/lib/openPullRequestLink.ts)

git fetch upstream --tags       # local refs and tags only; see the note at the top
SINCE=$(git log -1 --date=short --format=%cd "$(git merge-base HEAD upstream/main)")
```

### `SINCE` is derived, never typed

It is the date of the commit the fork branched from upstream.

- **Window:** exactly what a rebase would bring in
- **Same fork head:** two agents agree
- **At each rebase:** it moves forward
- **So it never** grows without bound
- **Filters on:** last activity, not creation
- **Example:** `badae6a5cc83` gives `2026-08-25`

`hyprws` at `badae6a5cc83` derives `2026-08-25`, the day before `v0.0.34` published.
An old thread upstream touched inside the window is news; one untouched since before it is not.

A survey that deliberately wants more history may set `SINCE` by hand.
The header then says the window was widened on purpose and names the derived date it was widened from.

Take `DOMAIN_PATHS` from that domain's rebase scan in [Fork delta](../../../../docs/internals/fork-delta.md), so the sweep covers the seams the fork sits on.
The header may only claim the window every block below enforced, and only the surfaces that ran.

### Issues and pull requests

```bash
gh search issues "$PHRASE" --repo "$REPO" --updated ">=$SINCE" --limit "$LIMIT" \
  --json number,title,state,createdAt,updatedAt

gh search prs "$PHRASE" --repo "$REPO" --updated ">=$SINCE" --limit "$LIMIT" \
  --json number,title,state,createdAt,updatedAt,url
```

`gh search` reports no match total, so a full page is the only truncation signal it gives.
When either command returns exactly `LIMIT` rows, raise `LIMIT` and rerun until it does not, and record the limit you settled on in `Gaps`.
`source control` at `--limit 30` returns 30 issues and 30 pull requests, both truncated.

### Discussions

Requests live in Discussions, not issues.
Ask for the total and the page info so a truncated sweep is visible:

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

`discussionCount` is how many threads matched; `hasNextPage` says whether this page held them all.
When it is `true`, page again with `after: $endCursor` or record the shortfall in `Gaps`.
Without those two fields a truncated sweep looks exactly like a complete one.

Both `-f` flags belong to a GraphQL `query`, one carrying the document and one a variable, which is the single `gh api` shape allowed to send parameters without an explicit `--method GET`.

The categories are `Ideas`, `Q&A`, and `Announcements`.
An open `Ideas` thread is a request and never a commitment, however many upvotes it carries.
Discussion search ranks loosely and returns off-domain threads, so read every title and drop the misses before they reach the report.

### Release contents

A tag list is metadata; the release body is the changelog, and it names pull requests no phrase search surfaced.

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

Both halves of that check have to hold, and a full page on its own proves nothing.
Upstream has 45 releases surviving `--exclude-pre-releases`, so `--limit 40` comes back full on every survey while its oldest row, `v0.0.0-alpha.9` from `2026-03-03`, sits far outside any derived window.
The sweep only lost work when the page is full **and** its oldest row is still inside the window, because that is where in-window releases fell off the end.

Raise `RELEASE_LIMIT` and rerun until one half stops holding, and record the limit you settled on.
If no reachable limit clears it, narrow the header and put the release surface in `Gaps`.

Every hit arrives carrying the first stable tag that shipped it, which is the rebase target the fork issue would otherwise derive.
`--exclude-pre-releases` drops the nightlies, which republish the same commits under a prerelease tag and would report the same work twice under a tag that is not the first stable one.
It drops only what GitHub flagged, which is why `v0.0.0-alpha.9` survives: those releases predate `pingdotgg/t3code#344`, which taught the release workflow to mark a suffixed version as a prerelease.
Nothing that old reaches a derived window, so the date filter keeps them out.

### Path history

```bash
git fetch upstream --tags
git log upstream/main --since="$SINCE" --no-merges \
  --pretty='%h %ad %s' --date=short -- "${DOMAIN_PATHS[@]}"
```

Squash subjects end in `(#NNNN)`, which turns each commit into a pull request to read.
This is the surface that finds work no phrase matched.

## Fix the freshness boundary

Stable releases only; nightlies and alphas are noise.

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

That `grep` is the stable-tag shape.
[Turn a merged fix into a rebase target](#turn-a-merged-fix-into-a-rebase-target) explains why it is written that way.

## Resolve the canonical item

The timeline of the best issue match names the pull requests claiming it and the duplicates folded into it.
Run it before trusting a phrase search.

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

Fork issues can appear in that timeline.
That is a cross-reference the fork leaked, not upstream activity, so cite in code spans and the next one does not fire.

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

One filter does all the work, because a stable upstream release tag is exactly `v<major>.<minor>.<patch>` with nothing after the patch number.
Anchoring on that shape drops three wrong answers in one pass:

- **Non-version tags:** `desktop-preview`
- **Which** `--sort=v:refname` sorts to the front
- **Prereleases:** `v0.0.4-alpha.1`
- **And every** `v0.0.35-nightly.20260827.1202`
- **Fork tags:** `v0.0.34-hyprws.4`
- **Which are** not upstream releases at all

Excluding prereleases is not tidiness.
GitHub marks them `isPrerelease: true`, so a prerelease is never the first stable tag, and a recipe that answers one reports a release carrying the fix when none does yet.
`--list 'v*'` with a `grep -v -e nightly -e hyprws` admits them: against `b74c7a79abbfbb7f6e8c5c4affb20784cea2b11c`, the merge commit of `pingdotgg/t3code#344`, it answers `v0.0.4-alpha.1` where the first stable tag is `v0.0.5`.

That first stable tag is the rebase target to name on the fork issue.
When nothing comes back, no stable release carries the fix yet, and upstream tags nightlies continuously, so check those before calling it unshipped:

```bash
git tag --contains <merge-commit-sha> --sort=v:refname | grep nightly | head -1
```

A nightly is the one prerelease the fork may rebase onto, and only as the deliberate exception [Fork development](../../../../docs/internals/fork-development.md) allows.
Name it as the rebase target only when the symptom blocks work before the next stable release, and say on the fork issue that the target is a nightly rather than a release.
When neither line answers, the fix merged after every existing tag.

To see whether the fork already carries it:

```bash
git merge-base --is-ancestor <merge-commit-sha> HEAD && echo "already in this fork branch"
```

## Trial a pending pull request

Use a worktree of its own.
`gh pr checkout` rewrites whatever worktree it runs in, so the "never on `hyprws`" rule has to be an assertion rather than an assumption about the previous line having worked.

Worktrunk creates through `wt switch --create`; there is no `wt new`.
Directory switching needs the shell integration, which an agent shell does not have, so create with `--no-cd` and resolve the path yourself.

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

`--force` is what lets the checkout reset the branch Worktrunk just created; without it `gh` refuses an existing branch.
Every command in that block is local or a read against upstream.
Remove the worktree with `wt remove` once the verdict is recorded.

Then verify narrowly and stop:

- **Run:** the tests the pull request touches
- **Typecheck:** the packages it changes
- **Never:** repo-wide checks
- **Reproduce:** the original symptom
- **Confirm:** the reverse case the fork cares about
- **Record:** adopt, adapt, or reject

The verdict goes on the fork issue.
The trial branch stays local, is never pushed to `pingdotgg/t3code`, and anything worth telling upstream becomes a saved suggestion for the human.
