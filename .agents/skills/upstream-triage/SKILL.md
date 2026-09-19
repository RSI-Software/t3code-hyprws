---
name: upstream-triage
description: Read upstream pingdotgg/t3code from the t3code-hyprws fork without posting to it, in two modes. Triage one symptom felt in the fork build into one upstream citation, one classification of merged, merged but untagged, pending pull request, draft, issue only, or unknown, and one fork action, handing every upstream-facing sentence to the human as a saved suggestion. Or survey one fork domain into a dated report that sorts every upstream item into one state and one kind and maps it to one fork follow-up, writing nothing to GitHub. Use when a fork build misbehaves, before filing a fork bug issue, when choosing between a fork fix and a rebase, when re-checking an upstream-watch issue, when asking what upstream is doing in a fork domain, or when an agent is about to write anything aimed at upstream.
---

# Upstream triage

One rule outranks everything else here: **agents never post to `pingdotgg/t3code`**.
No issues, pull requests, comments, reviews, or reactions.
Reads are fine; the human posts.

Two modes share the hunt commands, the classification vocabulary, the citation format, and that rule.

| Mode       | Input                         | Output                                   |
| ---------- | ----------------------------- | ---------------------------------------- |
| **Triage** | One symptom in the fork build | One citation, one class, one fork action |
| **Survey** | One fork domain               | One dated report mapped to the fork      |

Triage runs from [Frame the symptom](#frame-the-symptom) to [File the fork issue](#file-the-fork-issue).
Survey runs from [Survey a domain](#survey-a-domain).
Both end at [Hand upstream-facing text over as a suggestion](#hand-upstream-facing-text-over-as-a-suggestion), and both obey [the read-only boundary](#stay-inside-the-read-only-boundary).

## Frame the symptom

1. Write one sentence a stranger could reproduce
2. Record the fork release it appeared on
3. Name surface, connection mode, provider
4. Walk the affected domain's rebase scan
5. Pick two to four three-word phrases

An upstream match has to cover the same surface, mode, and provider.
The rebase scan is in [Fork delta](../../../docs/internals/fork-delta.md), and it says whether a fork patch owns the seam.
Say so when a fork-only file sits on the path, and keep triaging anyway.
GitHub search does not match long prose, so three words beat a sentence.

## Hunt upstream with reads only

Run the commands in [references/upstream-search.md](references/upstream-search.md) in order, and stop as soon as one item is clearly canonical.

### Order

1. Search upstream issues on each phrase
2. Search pull requests on the same phrases
3. Then on the file path the symptom touches
4. Read the best issue match's timeline
5. Search merged history if nothing open matches

Step 4 is where the claiming pull requests and the duplicate chain appear, and it usually finds items the phrase search missed.

### Keep

- **Prefer:** the oldest issue the rest duplicate
- **Prefer:** the newest live pull request
- **List:** every live candidate, not the first
- **Record:** number, title, state, both dates
- **Merged:** merge commit and first stable tag

## Classify against one table

| Signal on the fix candidate                                   | Class          |
| ------------------------------------------------------------- | -------------- |
| Pull request has a non-null `mergedAt`                        | **merged**     |
| Pull request is open and not a draft                          | **PR pending** |
| Pull request is open and a draft                              | **draft**      |
| An issue exists, every pull request closed unmerged or absent | **issue only** |
| No upstream issue and no upstream pull request                | **unknown**    |

- **Read `isDraft`:** never the title
- **Open:** always **PR pending** or **draft**
- **Closed unmerged:** not a fix, so reclassify
- **No stable tag yet:** still **merged**
- **Already in the fork's base:** **unknown**

That last row means the symptom is something else.

## Take the fork action for the class

### Merged

Resolve the merge commit to the first stable tag containing it, verify the fix is real on that tag, and file a fork issue whose action is a rebase onto that tag.
Never carry a fork patch for a fix that is one rebase away.

#### Merged, untagged

No upstream release carries the fix yet.
Never name a tag that does not exist.

- **Record:** the class `merged, untagged`
- **Cite:** merge commit and merge date
- **File:** an `upstream-watch` fork issue
- **Action:** rebase onto the next stable tag
- **Re-check:** at every rebase
- **Name the tag:** as soon as one contains it

When the symptom blocks work before that tag ships, name the nightly tag that already contains the commit as the rebase target instead.
[Fork development](../../../docs/internals/fork-development.md) allows a nightly target for exactly that case.
Fix in the fork under `upstream-fixes` only when no tag contains the commit at all, keeping the patch small enough to drop on the rebase that carries the real fix.

### PR pending

Choose one route and say why.

| Route     | When                              | What it costs                                                                                                                            |
| --------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Watch** | Likely to land, symptom tolerable | A fork issue labelled `upstream-watch` carrying the citation, its state and dates, and what the fork does meanwhile                      |
| **Trial** | The symptom blocks work           | Rebase the pull request head onto `hyprws` in its own worktree, test it, and record an adopt, adapt, or reject verdict on the fork issue |

A sibling task owns creating the `upstream-watch` label and the per-rebase re-check; reference the label, never create it here.
The trial procedure is in the reference file.
Never push a trial branch anywhere near upstream and never comment on the pull request.
Trial findings become a suggestion for the human.

### Draft

An open draft is upstream saying the fix is not ready, so the fork neither waits on it nor adopts it.

- **File:** an `upstream-watch` fork issue
- **Say plainly:** the pull request is a draft
- **Then take:** the **issue only** action
- **Trial it:** only if the fork fix is large
- **Record:** a draft head can be rewritten
- **Or:** abandoned without notice

Re-check reclassifies it: ready for review becomes **PR pending**, closed unmerged becomes **issue only**, merged as-is becomes **merged**.

### Issue only

File or update a fork issue carrying the citation and label it `upstream-watch`.
Fix in the fork only when the symptom blocks work.
That fix carries `Fork-Domain: upstream-fixes`, `Fork-Tier: bugfix`, and `Fork-Upstreamable: yes`, and stays small enough to drop the moment upstream lands its own.

When the fork's reproduction adds something the upstream issue lacks, draft a comment for the human.

### Unknown

Fix in the fork under `upstream-fixes` when the symptom blocks work.
Otherwise file the fork issue with the class `unknown`, `Upstream: none found`, and the exact search phrases you used, so the next pass repeats the search instead of inventing new ones.
Then draft an upstream bug report for the human.

## File the fork issue

The body carries all of this:

```text
Origin: the fork symptom you were working on, and the command or evidence that exposed it.
Symptom, and the fork release it appeared on.
Upstream: `pingdotgg/t3code#NNNN`, <state>, opened <date>, last updated <date>.
  Unknown class: write `Upstream: none found` and list the exact search phrases you ran, one per line.
  Merged, untagged: cite the merge commit and its merge date where the tag would go.
Classification: merged | merged, untagged | PR pending | draft | issue only | unknown.
Fork action: rebase target, watch, trial, or fork fix, with how it gets verified.
```

Write every upstream number as a code span: `` `pingdotgg/t3code#4379` ``.
A bare number or a plain URL fires a cross-reference on the upstream thread, which is a post the fork did not intend to make.

### Create or update

The fork issue is a normal tracked issue, so `gh-tracking` doctrine applies unchanged.
Route the prose through the `gh-post` skill first and write it to `.dump/upstream-triage/<slug>.md`, outside the tracked tree and never committed.

One read decides create against update:

```bash
gh issue list --repo RSI-Software/t3code-hyprws --state all --limit 20 \
  --search "<two or three symptom words> in:title,body" \
  --json number,title,state,labels
```

A re-check of a symptom that already owns a fork issue updates it.
A first triage, and only a first triage, creates one.

### Create, then label

This is two commands on purpose and does not collapse into one.
`ghb issue create --label` takes only the governed core vocabulary and refuses the repository-local `upstream-watch`.
`ghb issue edit --label` takes any existing repository label, so the label lands on a second command against the number the create printed.

```bash
ghb issue create --repo RSI-Software/t3code-hyprws \
  --title "<symptom in one line>" \
  --body-file .dump/upstream-triage/<slug>.md \
  --type "Bug 🐛" --priority Medium \
  --source "upstream-triage · <symptom in two or three words>" \
  --label <domain label> \
  --project 15 --status Inbox --no-relationship
```

```bash
ghb issue edit RSI-Software/t3code-hyprws#<n> --label upstream-watch
```

The label command warns that the repository has no local label write policy and applies the label anyway.
That warning is the expected output, not a failure.

### Update a filing

`ghb` refuses a body that does not end in the attestation the last publication left, so rewrite the live body.

```bash
gh issue view <n> --repo RSI-Software/t3code-hyprws --json body --jq .body \
  > .dump/upstream-triage/<slug>.md
# Rewrite the prose above the trailing `<!-- gh-bot:attest ... -->` line and leave that line last.
ghb issue edit RSI-Software/t3code-hyprws#<n> \
  --body-file .dump/upstream-triage/<slug>.md
```

### Filing rules

- **Agent filing:** `--source` plus an `Origin` line
- **Free text:** fine with no `repo#number`
- **Empty `--source`:** human-directed only
- **`--project 15`:** the durable fork board
- **Every filing:** a board or `--no-project`
- **`--priority High`:** the symptom blocks work

`--project 15` is the fork board, `t3code-hyprws: Durable fork`, and membership is never inferred.
`upstream-watch` belongs on the classes that wait: **merged, untagged**, **PR pending**, **draft**, and **issue only**, beside the domain label the create earns.
Skip the label command on a **merged** fix with a named rebase target.
Leave `--parent` out unless a fork tracker already owns the symptom; an unhomed filing lands `Untriaged 📥` and `ghb` prints the homing ladder.
Read `ghb issue create --help` and `ghb issue edit --help` for the full contracts, and resume a partial receipt instead of filing a replacement.

## Survey a domain

Survey answers "what is upstream doing in this area", not "what is this one bug".
A maintainer names a fork domain and gets back what upstream has shipped, what it is working on, and what it has turned down.

The report is a fork-side artifact that posts nothing: no upstream item, no fork issue, no tracked file.
It proposes follow-ups and the human decides which become work.

It writes two local things: the report file outside the tracked tree, and whatever `git fetch upstream --tags` updates in this clone.
That fetch is the ordinary cost of reading upstream history, and it is what makes tag containment answer truthfully.

### Fix the scope before searching

Record all of this first.
It is the report's header, and a reader must never have to guess how stale the report is.

| Field                  | How to get it                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository surveyed    | `pingdotgg/t3code`. Always name it; the fork is a different repository with its own numbers                                                                                                                                               |
| Fork's upstream base   | The stable tag containing `git merge-base HEAD upstream/main`                                                                                                                                                                             |
| Latest upstream stable | The newest non-prerelease tag, and when it was published                                                                                                                                                                                  |
| Survey date            | The day the sweeps ran                                                                                                                                                                                                                    |
| Window                 | The one date every sweep filtered on, derived from the fork's upstream base by the reference file's rule, filtering on last activity rather than creation. Say when it was widened by hand, and name the derived date it was widened from |
| Surfaces read          | Which of issues, pull requests, discussions, releases, and path history were actually swept                                                                                                                                               |
| Truncation             | Every sweep that hit its `--limit` or returned `hasNextPage: true`, and what you raised it to                                                                                                                                             |
| Phrases and paths      | The exact phrases and rebase-scan paths, so the next survey repeats them                                                                                                                                                                  |

A survey without this header is unusable a week later.
A sweep that hit its limit and does not say so is worse than no sweep.

The header describes the sweeps and never promises more than they did.
Claim the window only because every surface filtered on that date, and list a surface only because its block ran.
When one surface could not honor the window, narrow the header to what the rest established and put that surface in `Gaps`.
A report that claims a window it did not enforce is a report that quietly missed work.

### Sweep every surface

Name the domain from the [Fork delta](../../../docs/internals/fork-delta.md) index, take its rebase-scan paths, and pick three to five short phrases from what it does.
Then run [Sweep a whole domain](references/upstream-search.md#sweep-a-whole-domain) and [Fix the freshness boundary](references/upstream-search.md#fix-the-freshness-boundary).

Triage stops at the first canonical item; a survey does not.

- **Sweep:** issues, pull requests, discussions
- **And:** release contents and path history
- **Once per phrase:** never once in total
- **Then read:** timelines of anything central
- **Record:** number, title, kind, state, dates
- **Merged:** merge commit and first stable tag

Timelines are where the pull request claiming an issue appears, and reading them is how a phrase sweep stops missing half the work.
An item without dates does not go in the report.

### Sort into states, and keep kind separate

The states reuse triage's vocabulary, so one word means the same thing in both modes.
Read the table top to bottom and take the first row that matches; every kept item takes exactly one state.

The order is load-bearing twice.
**declined** sits above **open** so a maintainer refusal on an item nobody has closed yet reads as a refusal rather than as work in review.
**resolved** sits last as the catch-all for any closed item the rows above missed.

| State                | Signal                                                                                                                                                                                                                                                               | Write it as                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **shipped**          | Merged pull request whose merge commit a stable tag contains                                                                                                                                                                                                         | "upstream has ..."                                                                           |
| **merged, untagged** | Merged pull request that no stable tag contains yet                                                                                                                                                                                                                  | "upstream merged ..., unreleased since `<latest stable tag>`"                                |
| **declined**         | Upstream refused it, open or closed: issue closed `NOT_PLANNED`, discussion closed `OUTDATED`, a `wontfix` label, a maintainer closing someone else's pull request unmerged over the change itself, or a maintainer's explicit refusal written on an item still open | "upstream declined ..."                                                                      |
| **withdrawn**        | Closed unmerged with no upstream verdict: the author closed their own pull request, or it was closed as a duplicate                                                                                                                                                  | "upstream never ruled on ...; the author withdrew it", "folded into `pingdotgg/t3code#NNNN`" |
| **draft**            | Pull request open with `isDraft: true`                                                                                                                                                                                                                               | "upstream has a draft ...", "not offered for review since <date>"                            |
| **open**             | Pull request open and not a draft, an open issue, or an open discussion                                                                                                                                                                                              | "upstream is considering ...", "in review since <date>"                                      |
| **resolved**         | Any other closed item: issue closed `COMPLETED` with no closing pull request, or discussion closed `RESOLVED`                                                                                                                                                        | "upstream closed ... as done; no merge commit cited"                                         |

Kind is a second axis, because "upstream fixed a defect here" and "upstream built a feature here" are different news for the fork.

| Kind             | Signal                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **defect**       | A `[Bug]:` issue, or a `fix(...)` pull request                                                                                                                                                                  |
| **feature**      | A `[Feature]:` discussion or issue, or a `feat(...)` pull request                                                                                                                                               |
| **performance**  | A `perf(...)` pull request. Kept off **defect** because the fork inherits the win by rebasing rather than by carrying a patch                                                                                   |
| **internal**     | `docs(...)`, `chore(...)`, `refactor(...)`, `test(...)`, `build(...)`, or `ci(...)`. No product behavior changes, so the fork's only interest is collision                                                      |
| **unclassified** | Anything left: no conventional prefix and no issue-template marker. Read what it changes and take the row it behaves like; write `unclassified` only when even that read is inconclusive, and say what you read |

That last row is where an unconventionally titled item lands before it is resolved, and it is why every item takes a kind.
`pingdotgg/t3code#344`, "Handle prerelease tags in GitHub release publishing", carries no prefix and no marker, and touches `.github/workflows/release.yml`, `apps/desktop/src/main.ts`, and `docs/release.md`, which is release plumbing, so it reads as **internal**.

### Five rules keep the report honest

#### Read `isDraft`, never the title

An open draft is upstream saying the work is not ready, which is different news from a pull request in review, and the two are indistinguishable from the title alone.

#### A closed discussion is not a declined one

GitHub closes discussions with `RESOLVED`, `OUTDATED`, and `DUPLICATE`, and only `OUTDATED` means upstream turned the request down.
Read `stateReason`, which the discussion sweep already returns.
`DUPLICATE` is not a verdict at all, on a discussion, an issue, or a pull request closed as one: follow it to the canonical item and report that one.

#### Closed unmerged is not declined either

Most closed pull requests upstream never earned a verdict.
`pingdotgg/t3code#8299` is titled "Withdrawn" and its own author closed it; `pingdotgg/t3code#8354`, `fix(server): use Codex native updater`, was closed by its own author as a duplicate of `pingdotgg/t3code#4065`.
Both are **withdrawn**, and calling either **declined** invents an upstream refusal the fork would then plan around, so read who closed it and what they said.
The reverse costs as much: when **declined** lands on an item still open, cite the refusal and say the item is open, because upstream can still change its mind.

#### Never name a tag that does not exist

A merged pull request no stable tag contains is **merged, untagged**, cited by merge commit and merge date.
Do not round it up to shipped and do not guess the tag it will land in.

#### An open item is never a commitment

No "upstream will ship this", no "coming in the next release".
Only "upstream has" for shipped, and "upstream is considering" or "is reviewing" for open.
Upstream has promised the fork nothing, an open pull request is one close away from **declined** or **withdrawn**, and an `Ideas` thread is a request however many upvotes it carries.

Before assigning **resolved**, read the item's timeline cross-references.
A closing pull request is usually there and turns the item into **shipped** or **merged, untagged**.
**resolved** is for the ones where that read also comes up empty, and the row says which.

### Map every item onto the fork

An item nobody can act on is trivia.
Map each kept item onto the fork domain it touches, matched through the rebase scans in [Fork delta](../../../docs/internals/fork-delta.md), and give it exactly one follow-up.
This table is a ladder too: take the first row that matches, and every item reaches one row.

| Follow-up         | When                                                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **rebase target** | **shipped**, the fork does not carry it yet, and the fork wants what it changed: it retires fork delta, it collides with fork delta, or it is behavior the fork gains by rebasing onto that tag. Settle "does not carry it yet" with `git merge-base --is-ancestor`, not by eye. Name the tag; only this row has one |
| **trial**         | **open** or **draft**, and the fork wants the behavior now. The procedure is in the reference file. A draft head can be rewritten or abandoned without notice, so record that beside the verdict                                                                                                                     |
| **watch**         | It would change what the fork carries, but the fork cannot act yet: **merged, untagged**, where the rebase is onto the next upstream tag rather than a named one, or **open** or **draft** the fork is not trialling now                                                                                             |
| **fork fix**      | **declined**, **withdrawn**, or **resolved** with nothing to rebase onto, or nothing upstream matched, and the fork needs the behavior anyway                                                                                                                                                                        |
| **note only**     | It touches a fork domain with nothing left to do: the fork already carries it, or it changes nothing the fork carries. Name the domain and say which                                                                                                                                                                 |
| **nothing**       | It touches no fork domain at all. Say so explicitly, because "no fork impact" is a finding, not an omission                                                                                                                                                                                                          |

The first four are for items the fork has work on; the last two absorb the rest.
A shipped item inside a fork domain that neither retires nor collides is not homeless: it is a **rebase target** while the fork has yet to pull it in, and **note only** once the fork carries it.

**watch** proposes a fork issue labelled `upstream-watch`, and a sibling task owns creating that label.
A survey proposes and never files, so even that stays a proposal for the human.
When a shipped item satisfies a domain's retirement condition, say so plainly; retiring fork delta is the most valuable thing a survey can find.

### Write the report

```text
# Upstream survey: <domain>

Repository: `pingdotgg/t3code`
Fork upstream base: <tag>
Latest upstream stable: <tag>, published <date>
Surveyed: <date>   Window: last activity since <date>
Surfaces: <only the ones that ran>
Phrases: <...>     Paths: <...>

## Shipped      number, title, kind, merged, merge commit, first stable tag, follow-up
## Unreleased   number, title, kind, merged, merge commit, latest stable tag it missed, follow-up
## Open         number, title, kind, state, draft or in review, created, last update, follow-up
## Declined     number, title, kind, the refusal and where it is written, whether the item is still open, follow-up
## Withdrawn    number, title, kind, closed, who closed it, the canonical item when it was a duplicate, follow-up
## Resolved     number, title, kind, closed, state reason, why no commit is cited, follow-up
## Fork impact  one row per fork domain: the items touching it, and the follow-up
## Gaps         surfaces that returned nothing, sweeps that truncated, and surfaces that could not honor the window
```

A section with no items says so in one line.
An empty `Declined` is a finding; a missing `Declined` is a reader wondering whether you looked.

Every upstream reference is a code span: `` `pingdotgg/t3code#8046` ``.
That rule matters more here than anywhere else in the skill, because a survey cites dozens of items at once and bare numbers fire a cross-reference on every thread it names.
Code-span every one, including the numbers inside tables and in `Gaps`.

Save the report in `.dump/upstream-surveys/<domain>-<date>.md` when that scratch directory exists, otherwise where the user names.
Never commit it.
It is a dated snapshot rather than documentation, so the next survey writes a new file instead of editing this one.

## Hand upstream-facing text over as a suggestion

Anything aimed at upstream is produced, never posted.

1. Write the complete title and body, or comment
2. Save it outside the tracked tree
3. Show it in chat with target and saved path
4. Say plainly that the human posts it
5. Record a declined post on the fork issue

Save to `.dump/upstream-drafts/<slug>.md` when that scratch directory exists, otherwise a path the user names, and never commit it.
Recording the decline keeps the unposted report deliberate rather than forgotten.

Draft in upstream's voice: their issue template, their terminology, no fork branding, no fork-only paths, and a reproduction that runs on an upstream build.
If the only reproduction needs the fork, stop, because that is a fork defect rather than an upstream report.

## Stay inside the read-only boundary

### Effective method decides

What makes an upstream call a read is its **effective HTTP method**, not which flags it spells out.
Per `gh api --help`, the method "is `GET` normally and `POST` if any parameters were added", and any `-f`/`-F` "will automatically switch the request method to `POST`".
A `--method`/`-X` rule alone never sees that switch.
`--input` is the same hazard from the other side: it hands `gh api` a request body, and a call carrying a body is a write however the method reads.

### `gh api` reads

A REST call is a read in exactly two shapes.

- **Bare:** no `-f`/`-F`, `--input`, or `-X`
- **Example:** a bare `issues/N/timeline` call
- **Or:** `--method GET` written out
- **Whenever:** the call carries any parameter
- **Example:** `--method GET -f state=closed`
- **Drop it:** and the same flags POST

A POST there is an issue the fork just opened upstream.

`gh api graphql` is the one exception, because GraphQL is POST by design and `-f` sets variables rather than a REST body.
It is allowed only for an operation whose keyword is `query`, never for a `mutation`, so read the operation before you run it.

### Allowed against upstream

- **Issues:** `gh issue view`, `gh issue list`
- **Pulls:** `gh pr view`, `list`, `diff`
- **Plus:** `gh pr checkout`, including `--force`
- **Releases:** `gh release list`, `view`
- **Also:** `gh search`, `git fetch upstream`
- **Local:** `log`, `tag`, `merge-base`

`gh pr checkout --force` rewrites only a local branch, and the local Git reads reach upstream data only through the already-fetched remote.

### Never against upstream

- **Issues:** `create`, `comment`, `edit`
- **Pulls:** `create`, `review`, `comment`
- **GraphQL:** any `mutation`
- **REST:** any `-X` other than `GET`
- **REST:** `-f`/`-F` without `--method GET`
- **Any:** `gh api --input`, `ghb`, `git push`

### Fork writes

`ghb issue create` and `ghb issue edit` are the only publishing commands this skill runs, and both name `RSI-Software/t3code-hyprws`.
Re-read the target repository on every publishing command before you run it: create takes `--repo`, edit takes it inside the `OWNER/REPO#N` selector.
Local-only and safe anywhere: `wt switch`, `wt list`, `wt remove`, `jq`, `git rev-parse`, and `git rebase`.
A trial worktree is local and is never pushed.

### Survey is stricter

It publishes nothing: no upstream call that is not a read, no fork issue, no tracked file changed.
Its only output is a report file outside the tracked tree.
It does run `git fetch upstream --tags`, which is a local write that sends nothing upstream and is required rather than optional, because `git tag --contains` answers out of local refs and an unfetched clone names the wrong tag or none at all.

## Re-check a watched item

An `upstream-watch` issue is not finished work.
Re-run its hunt and classification at each upstream rebase, update the citation's state and dates, and close it only once the fix is verified in a fork release.

## Troubleshoot predictably

| Symptom                                               | Read                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Empty search results                                  | The phrase is too long. Cut it to two or three words                                                                                                                                                                                                                                                                                                                                                                                                         |
| Too many results                                      | Search by the file path the symptom touches instead of its words                                                                                                                                                                                                                                                                                                                                                                                             |
| Best match closed as a duplicate                      | Follow its state reason and timeline to the canonical issue, and cite that one                                                                                                                                                                                                                                                                                                                                                                               |
| Looks merged, null `mergedAt`                         | It was closed unmerged. It is not a fix                                                                                                                                                                                                                                                                                                                                                                                                                      |
| No tag contains a merge commit                        | Fetch upstream tags first. If still nothing, it merged after the newest tag: classify it merged, untagged and take that route under [Merged](#merged)                                                                                                                                                                                                                                                                                                        |
| A "first stable tag" that is not one                  | A non-version tag such as `desktop-preview`, a prerelease such as `v0.0.4-alpha.1` or any `-nightly.`, or a fork tag such as `v0.0.34-hyprws.4`. The tag command lost the reference recipe's stable shape, which matches `v<major>.<minor>.<patch>` and nothing else. A prerelease is the dangerous one, because it looks like an answer while no stable release carries the fix. Naming a nightly is separate and deliberate, taken under [Merged](#merged) |
| Window differs from the last survey's                 | `SINCE` derives from the fork's upstream base commit, so it moves at every rebase. That is the design. A hand-typed window is a deliberate widening, and the header must say so and name the derived date                                                                                                                                                                                                                                                    |
| A section claims a window a surface never filtered on | Bind the window once and pass it to every sweep, as the reference file's sweep block does. A header is a claim about the commands, not a wish                                                                                                                                                                                                                                                                                                                |
| `gh issue list --search` finds nothing real           | A multi-word phrase in front of a qualifier needs its own quotes: `'"github issue" in:title'`, not `"github issue in:title"`                                                                                                                                                                                                                                                                                                                                 |
| Issues look empty                                     | Requests are in Discussions. Sweep them over GraphQL before reporting a gap                                                                                                                                                                                                                                                                                                                                                                                  |
| Off-domain discussion results                         | Its ranking is loose. Read every title and drop the misses by hand                                                                                                                                                                                                                                                                                                                                                                                           |
| Several live pull requests claim one issue            | Cite them all on the fork issue and trial the newest, since upstream has not picked one either                                                                                                                                                                                                                                                                                                                                                               |
