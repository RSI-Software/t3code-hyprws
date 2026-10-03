---
name: upstream-triage
description: Read upstream pingdotgg/t3code from the t3code-hyprws fork without posting to it, in two modes. Triage one symptom felt in the fork build into a citation, a classification of merged, merged but untagged, pending pull request, draft, issue only, or unknown, and one fork action, handing every upstream-facing sentence to the human as a saved suggestion instead of posting it. Or survey one fork domain into a dated report that sorts every upstream item into one state and one kind, and maps each item to exactly one fork follow-up, writing nothing to GitHub. Use when a fork build misbehaves, before filing a fork bug issue, when deciding whether to fix in the fork or wait for a rebase, when re-checking an upstream-watch issue, when asking what upstream is doing in a fork domain such as GitHub integration, workspace files, or project windows, or when an agent is about to write anything aimed at upstream.
---

# Upstream triage

One rule outranks everything else in this skill: **agents never post to `pingdotgg/t3code`**.
No issues, pull requests, comments, reviews, or reactions. Reads are fine. The human posts.

The skill has two modes. They share the hunt commands, the classification vocabulary, the citation format, and the rule above.

| Mode       | Input                              | Output                                                                |
| ---------- | ---------------------------------- | --------------------------------------------------------------------- |
| **Triage** | One symptom felt in the fork build | One upstream citation, one classification, one fork action.           |
| **Survey** | One fork domain                    | One dated report of upstream work in that domain, mapped to the fork. |

Triage runs from [Frame the symptom](#frame-the-symptom) through [File the fork issue](#file-the-fork-issue). Survey runs from [Survey a domain](#survey-a-domain). Both end at [Hand upstream-facing text over as a suggestion](#hand-upstream-facing-text-over-as-a-suggestion), and both obey [the read-only boundary](#stay-inside-the-read-only-boundary).

Everything up to [File the fork issue](#file-the-fork-issue) turns a symptom felt in the fork build into one canonical upstream citation, one classification, and one fork action.

## Frame the symptom

1. Write the symptom as one sentence a stranger could reproduce, and record the fork release it appeared on.
2. Name the surface (web, desktop, mobile), the connection mode, and the provider, because an upstream match has to cover the same one.
3. Check whether a fork patch owns the seam. Walk the affected domain's rebase scan in [Fork delta](../../../docs/internals/fork-delta.md); if a fork-only file sits on the path, say so and keep triaging anyway.
4. Pick two to four short search phrases from the symptom. Three words beat a sentence: GitHub search does not match long prose.

## Hunt upstream with reads only

Run the commands in [references/upstream-search.md](references/upstream-search.md) in this order, and stop as soon as one item is clearly canonical.

1. Search upstream issues on each short phrase.
2. Search upstream pull requests on the same phrases, then on the file path the symptom touches.
3. Read the timeline cross-references of the best issue match. That is where the pull requests claiming it and the duplicate chain appear, and it usually finds items the phrase search missed.
4. Search merged history only when nothing open matches.

Prefer the oldest issue that the others were closed as duplicates of. Prefer the newest live pull request as the fix candidate, and list every live candidate rather than the first one you find.

Record, for each kept item: number, title, state, created date, last update, and for a merged pull request its merge commit and the first stable tag containing it.

## Classify against one table

| Signal on the fix candidate                                                    | Class          |
| ------------------------------------------------------------------------------ | -------------- |
| Pull request has a non-null `mergedAt`                                         | **merged**     |
| Pull request is open and not a draft                                           | **PR pending** |
| Pull request is open and a draft                                               | **draft**      |
| An issue exists, and every remaining pull request is closed unmerged or absent | **issue only** |
| No upstream issue and no upstream pull request                                 | **unknown**    |

Every open pull request lands in exactly one of **PR pending** and **draft**; read `isDraft`, never the title.
A pull request closed without merging is not a fix. Drop it and reclassify.
A merged fix that no stable tag contains yet is still **merged**, and its untagged case has its own action below.
A merged fix that is already in the fork's current upstream base means the symptom is something else; treat it as **unknown**.

## Take the fork action for the class

### Merged

Resolve the merge commit to the first stable tag containing it, verify the fix is real on that tag, and file a fork issue whose action is a rebase onto that tag. Do not carry a fork patch for a fix that is one rebase away.

**Merged, untagged.** When no stable tag contains the merge commit, no upstream release carries the fix yet. Never name a tag that does not exist. Record the classification as "merged, untagged", cite the merge commit and its merge date instead of a tag, and file or update a fork issue labelled `upstream-watch` whose action is the rebase onto the next stable tag. Re-check it at each rebase and name the tag as soon as one contains the commit. When the symptom blocks work before that tag ships, name the nightly tag that already contains the commit as the rebase target instead — [Fork development](../../../docs/internals/fork-development.md) allows a nightly target for exactly that case — and fix in the fork under `upstream-fixes` only when no tag contains the commit at all, keeping the patch small enough to drop on the rebase that carries the real fix.

### PR pending

Choose one of two routes and say why.

- **Watch.** File a fork issue labelled `upstream-watch` when the pull request looks likely to land and the symptom is tolerable. A sibling task owns creating that label and the per-rebase re-check; reference the label, do not create it here. The issue carries the citation, its state and dates, and what the fork does in the meantime.
- **Trial.** Rebase the pull request head onto `hyprws` in its own worktree and test it when the symptom blocks work. The procedure is in the reference file. Record an adopt, adapt, or reject verdict on the fork issue.

Never push a trial branch anywhere near upstream and never comment on the pull request. Trial findings become a suggestion for the human.

### Draft

An open draft is upstream saying the fix is not ready, so the fork neither waits on it nor adopts it.

File or update a fork issue labelled `upstream-watch` that cites the pull request and says plainly that it is a draft, then take the **issue only** action for the symptom itself: fix in the fork under `upstream-fixes` only when the symptom blocks work. Trial a draft only when that fork fix would otherwise be large, and record on the fork issue that a draft head can be rewritten or abandoned without notice.

Re-check reclassifies it. A draft marked ready for review becomes **PR pending**; a draft closed unmerged becomes **issue only**; a draft merged as-is becomes **merged**.

### Issue only

File or update a fork issue carrying the citation and label it `upstream-watch`. Fix in the fork only when the symptom blocks work; that fix carries `Fork-Domain: upstream-fixes`, `Fork-Tier: bugfix`, `Fork-Upstreamable: yes`, and stays small enough to drop the moment upstream lands its own.

When the fork's reproduction adds something the upstream issue lacks, draft a comment for the human.

### Unknown

Fix in the fork under `upstream-fixes` when the symptom blocks work; otherwise file the fork issue with the classification `unknown`, `Upstream: none found`, and the exact search phrases you used, so the next pass can repeat the search instead of inventing new ones. Then draft an upstream bug report for the human.

## File the fork issue

The body carries all of this:

```text
Origin: the fork symptom you were working on, and the command or evidence that exposed it.
Symptom, and the fork release it appeared on.
Upstream: `pingdotgg/t3code#NNNN` — <state>, opened <date>, last updated <date>.
  Unknown class: write `Upstream: none found` and list the exact search phrases you ran, one per line.
  Merged, untagged: cite the merge commit and its merge date where the tag would go.
Classification: merged | merged, untagged | PR pending | draft | issue only | unknown.
Fork action: rebase target, watch, trial, or fork fix, with how it gets verified.
```

Write every upstream number as a code span: `` `pingdotgg/t3code#4379` ``. A bare number or a plain URL fires a cross-reference on the upstream thread, which is a post the fork did not intend to make.

### Publish it, or update what you already filed

The fork issue is a normal tracked issue, so `gh-tracking` doctrine applies unchanged. Route the prose through the `gh-post` skill first, write it to a scratch path outside the tracked tree — `.dump/upstream-triage/<slug>.md`, never committed — and publish against `RSI-Software/t3code-hyprws`.

One read decides create against update:

```bash
gh issue list --repo RSI-Software/t3code-hyprws --state all --limit 20 \
  --search "<two or three symptom words> in:title,body" \
  --json number,title,state,labels
```

A re-check of a symptom that already owns a fork issue updates that issue. A first triage, and only a first triage, creates one.

Create, then label. This is two commands on purpose, and it does not collapse into one: `ghb issue create --label` takes only the governed core vocabulary, and `upstream-watch` is a repository-local label it refuses. `ghb issue edit --label` takes any existing repository label, so the label lands on a second command against the number the create printed.

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

The label command warns that the repository has no local label write policy and applies the existing label anyway. That warning is the expected output, not a failure.

Update an issue you already filed by rewriting its live body, because `ghb` refuses a body that does not end in the attestation the last publication left:

```bash
gh issue view <n> --repo RSI-Software/t3code-hyprws --json body --jq .body \
  > .dump/upstream-triage/<slug>.md
# Rewrite the prose above the trailing `<!-- gh-bot:attest ... -->` line and leave that line last.
ghb issue edit RSI-Software/t3code-hyprws#<n> \
  --body-file .dump/upstream-triage/<slug>.md
```

- An agent filing must set `--source` and carry one `Origin:` line in the body. Free text is fine when no `repo#number` exists; only a human-directed filing may leave `--source` empty.
- `--project 15` is the fork board, `t3code-hyprws: Durable fork`. Every filing chooses a board or `--no-project`; membership is never inferred.
- `--priority High` when the symptom blocks work, `Medium` otherwise.
- `upstream-watch` belongs on the classes that wait — **merged, untagged**, **PR pending**, **draft**, and **issue only** — beside the domain label the symptom earns on the create. It does not belong on a **merged** fix with a named rebase target, so skip the label command there.
- Leave `--parent` out unless a fork tracker already owns the symptom. An unhomed filing lands `Untriaged 📥`, and `ghb` prints the homing ladder for the next triage pass.
- Read `ghb issue create --help` and `ghb issue edit --help` for the full contracts, and resume a partial receipt instead of filing a replacement.

## Survey a domain

Survey mode answers a different question. Not "what is this one bug" but "what is upstream doing in this area". A maintainer names a fork domain — GitHub integration, workspace files, project windows — and gets back what upstream has shipped, what it is working on, and what it has turned down, instead of hand-searching five surfaces.

The report is a fork-side artifact. Producing it posts nothing to GitHub: no upstream issue, pull request, comment, review, or reaction, and no fork issue either. It changes no tracked file in this repository. It proposes follow-ups and the human decides which become work.

Two things it does write, both local. The report file itself, outside the tracked tree. And whatever `git fetch upstream --tags` updates in this clone — the `upstream/*` remote-tracking refs, the tags, and `FETCH_HEAD` — which is the ordinary cost of reading upstream history and is what makes tag containment answer truthfully.

### Fix the scope before searching

Record all of this first. It is the report's header, and a reader must never have to guess how stale the report is.

| Field                  | How to get it                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository surveyed    | `pingdotgg/t3code`. Always name it. The fork is a different repository with its own numbers.                                                                                                                                                                   |
| Fork's upstream base   | The stable tag containing `git merge-base HEAD upstream/main`.                                                                                                                                                                                                 |
| Latest upstream stable | The newest non-prerelease tag, and when it was published.                                                                                                                                                                                                      |
| Survey date            | The day the sweeps ran.                                                                                                                                                                                                                                        |
| Window                 | The one date every sweep filtered on, derived from the fork's upstream base commit by the reference file's rule, and that it filters on last activity rather than creation. Say so when it was widened by hand, and name the derived date it was widened from. |
| Surfaces read          | Which of issues, pull requests, discussions, releases, and path history were actually swept.                                                                                                                                                                   |
| Truncation             | Every sweep that hit its `--limit` or came back with `hasNextPage: true`, and what you raised it to.                                                                                                                                                           |
| Phrases and paths      | The exact search phrases and rebase-scan paths, so the next survey repeats them.                                                                                                                                                                               |

A survey without this header is unusable a week later. A sweep that hit its limit and does not say so is worse than no sweep.

The header describes the sweeps; it never promises more than they did. Claim the window only because every surface filtered on that date, and list a surface only because its block ran. If one surface could not honor the window, narrow the header to what the rest established and put that surface in `Gaps` — a report that claims a window it did not enforce is a report that quietly missed work.

### Sweep every surface

Name the domain from the [Fork delta](../../../docs/internals/fork-delta.md) index, take its rebase-scan paths, and pick three to five short phrases from what it does. Then run [Sweep a whole domain](references/upstream-search.md#sweep-a-whole-domain) and [Fix the freshness boundary](references/upstream-search.md#fix-the-freshness-boundary).

Triage stops at the first canonical item. A survey does not. Sweep all five surfaces — issues, pull requests, discussions, release contents, and path history — once for every phrase, not once in total. Then read the timeline cross-references of anything central, because that is where the pull request claiming an issue appears and it is how a phrase sweep stops missing half the work.

Record for every kept item: number, title, kind, state, created date, last update, and for a merged pull request its merge commit and the first stable tag containing it. An item without dates does not go in the report.

### Sort into states, and keep kind separate

The states reuse triage's vocabulary, so one word means the same thing in both modes. Read the table top to bottom and take the first row that matches; every kept item takes exactly one state. The order is load-bearing twice: **declined** sits above **open** so that a maintainer refusal on an item nobody has closed yet reads as a refusal instead of as work in review, and **resolved** sits last as the catch-all for any closed item the rows above missed. Kind is a second axis, because "upstream fixed a defect here" and "upstream built a feature here" are different news for the fork.

| State                | Signal                                                                                                                                                                                                                                                               | Write it as                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **shipped**          | Merged pull request whose merge commit a stable tag contains                                                                                                                                                                                                         | "upstream has ..."                                                                           |
| **merged, untagged** | Merged pull request that no stable tag contains yet                                                                                                                                                                                                                  | "upstream merged ..., unreleased since `<latest stable tag>`"                                |
| **declined**         | Upstream refused it, open or closed: issue closed `NOT_PLANNED`, discussion closed `OUTDATED`, a `wontfix` label, a maintainer closing someone else's pull request unmerged over the change itself, or a maintainer's explicit refusal written on an item still open | "upstream declined ..."                                                                      |
| **withdrawn**        | Closed unmerged with no upstream verdict: the author closed their own pull request, or it was closed as a duplicate of another item                                                                                                                                  | "upstream never ruled on ...; the author withdrew it", "folded into `pingdotgg/t3code#NNNN`" |
| **draft**            | Pull request open with `isDraft: true`                                                                                                                                                                                                                               | "upstream has a draft ...", "not offered for review since <date>"                            |
| **open**             | Pull request open and not a draft, an open issue, or an open discussion                                                                                                                                                                                              | "upstream is considering ...", "in review since <date>"                                      |
| **resolved**         | Any other closed item, which in practice is one closed as done with nothing citable: issue closed `COMPLETED` with no closing pull request, or discussion closed `RESOLVED`                                                                                          | "upstream closed ... as done; no merge commit cited"                                         |

| Kind             | Signal                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **defect**       | A `[Bug]:` issue, or a `fix(...)` pull request.                                                                                                                                                                  |
| **feature**      | A `[Feature]:` discussion or issue, or a `feat(...)` pull request.                                                                                                                                               |
| **performance**  | A `perf(...)` pull request. Kept off **defect** because the fork inherits the win by rebasing rather than by carrying a patch.                                                                                   |
| **internal**     | `docs(...)`, `chore(...)`, `refactor(...)`, `test(...)`, `build(...)`, or `ci(...)`. No product behavior changes, so the fork's only interest is collision.                                                      |
| **unclassified** | Anything left: no conventional prefix and no issue-template marker. Read what it changes and take the row it behaves like; write `unclassified` only when even that read is inconclusive, and say what you read. |

That last row is where an unconventionally titled item lands before it is resolved, and it is why every item takes a kind. `pingdotgg/t3code#344`, "Handle prerelease tags in GitHub release publishing", carries no prefix and no marker; it touches `.github/workflows/release.yml`, `apps/desktop/src/main.ts`, and `docs/release.md`, which is release plumbing, so it reads as **internal**.

Five rules keep the report honest.

- **Read `isDraft`, never the title.** An open draft is upstream saying the work is not ready, which is different news from a pull request in review, and the two are indistinguishable from the title alone.
- **A closed discussion is not a declined one.** GitHub closes discussions with `RESOLVED`, `OUTDATED`, and `DUPLICATE`, and only `OUTDATED` means upstream turned the request down. Read `stateReason`, which the discussion sweep already returns. `DUPLICATE` is not a verdict at all, on a discussion, an issue, or a pull request closed as one: follow it to the canonical item and report that one instead.
- **Closed unmerged is not declined either.** Most closed pull requests upstream never earned a verdict. `pingdotgg/t3code#8299` is titled "Withdrawn" and its own author closed it; `pingdotgg/t3code#8354`, `fix(server): use Codex native updater`, was closed by its own author as a duplicate of `pingdotgg/t3code#4065`. Both are **withdrawn**. Calling either **declined** invents an upstream refusal the fork would then plan around, so read who closed it and what they said. The reverse costs as much: when **declined** lands on an item that is still open, cite the refusal and say the item is open, because upstream can still change its mind.
- **Never name a tag that does not exist.** A merged pull request no stable tag contains is **merged, untagged**, cited by merge commit and merge date. Do not round it up to shipped and do not guess the tag it will land in.
- **An open item is never a commitment.** No "upstream will ship this", no "coming in the next release". Only "upstream has" for shipped, and "upstream is considering" or "is reviewing" for open. Upstream has promised the fork nothing, an open pull request is one close away from **declined** or **withdrawn**, and an `Ideas` thread is a request however many upvotes it carries.

Before assigning **resolved**, read the item's timeline cross-references. A closing pull request is usually there and turns the item into **shipped** or **merged, untagged**; **resolved** is for the ones where that read also comes up empty, and the row says which.

### Map every item onto the fork

An item nobody can act on is trivia. Map each kept item onto the fork domain it touches, matched through the rebase scans in [Fork delta](../../../docs/internals/fork-delta.md), and give it exactly one follow-up. This table is a ladder too: take the first row that matches, top to bottom. Every item reaches one row. The first four are for items the fork has work on, and the last two absorb the rest: **note only** for an item inside a fork domain with nothing left to do, **nothing** for an item outside every fork domain. A shipped item inside a fork domain that neither retires nor collides is not homeless — it is a **rebase target** while the fork has yet to pull it in, and **note only** once the fork carries it.

| Follow-up         | When                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **rebase target** | **shipped**, the fork does not carry it yet, and the fork wants what it changed: it retires fork delta, it collides with fork delta, or it is behavior the fork gains by rebasing onto that tag. Settle "does not carry it yet" with `git merge-base --is-ancestor`, not by eye. Name the tag; only this row names one, because only this row has one. |
| **trial**         | **open** or **draft**, and the fork wants the behavior now. The procedure is in the reference file. A draft head can be rewritten or abandoned without notice, so record that beside the verdict.                                                                                                                                                      |
| **watch**         | It would change what the fork carries, but the fork cannot act on it yet: **merged, untagged**, where the rebase is onto the next upstream tag rather than a named one, or **open** or **draft** the fork is not trialling now.                                                                                                                        |
| **fork fix**      | **declined**, **withdrawn**, or **resolved** with nothing the fork can rebase onto, or nothing upstream matched — and the fork needs the behavior anyway.                                                                                                                                                                                              |
| **note only**     | It touches a fork domain, but there is nothing left to do: the fork already carries it, or it changes nothing the fork carries — no collision, no retirement, no behavior the fork wants. Name the domain and say which of those it is.                                                                                                                |
| **nothing**       | It touches no fork domain at all. Say so explicitly, because "no fork impact" is a finding, not an omission.                                                                                                                                                                                                                                           |

**watch** proposes a fork issue labelled `upstream-watch`. A sibling task owns creating that label; reference it, do not create it. A survey proposes and never files, so even that stays a proposal for the human.

When a shipped item satisfies a domain's retirement condition, say so plainly. Retiring fork delta is the most valuable thing a survey can find.

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

A section with no items says so in one line. An empty `Declined` is a finding; a missing `Declined` is a reader wondering whether you looked.

Every upstream reference is a code span: `` `pingdotgg/t3code#8046` ``. That rule matters more here than anywhere else in the skill. A survey cites dozens of items at once, so a report written with bare numbers or plain URLs fires a cross-reference on every upstream thread it names — dozens of posts the fork never meant to make. Code-span every one, including the numbers inside tables and the ones in the `Gaps` section.

Save the report outside the tracked tree, in `.dump/upstream-surveys/<domain>-<date>.md` when that scratch directory exists, otherwise where the user names. Never commit it. It is a dated snapshot rather than documentation, so the next survey writes a new file instead of editing this one.

## Hand upstream-facing text over as a suggestion

Anything aimed at upstream — a bug report, a reproduction, a comment on a pull request — is produced, never posted.

1. Write the complete text: a title and body for a new report, or the exact comment.
2. Save it outside the tracked tree, in `.dump/upstream-drafts/<slug>.md` when that scratch directory exists, otherwise in a path the user names. Never commit it.
3. Show the complete text in chat with its target (`pingdotgg/t3code#NNNN`, or "new issue") and the saved path, and say plainly that the human posts it.
4. If the human declines to post, record on the fork issue that the upstream report is deliberately unposted.

Draft in upstream's voice: their issue template, their terminology, no fork branding, no fork-only paths, and a reproduction that runs on an upstream build. If the only reproduction needs the fork, stop — that is a fork defect, not an upstream report.

## Stay inside the read-only boundary

- What makes an upstream call a read is its **effective HTTP method**, not which flags it spells out. `gh api` sends `GET` only while the call carries no parameters: per `gh api --help`, "the default HTTP request method is `GET` normally and `POST` if any parameters were added", and adding any `-f`/`-F` "will automatically switch the request method to `POST`". A `--method`/`-X` rule alone never sees that switch. `--input` is the same hazard from the other side: it hands `gh api` a request body, and a call carrying a body is a write however the method reads.
- Allowed against upstream: `gh issue view`, `gh issue list`, `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checkout` including `--force`, which rewrites only a local branch, `gh release list`, `gh release view`, `gh search`, and `git fetch upstream`. `gh pr checkout` only writes to the local worktree.
- Allowed locally, and reaching upstream data only through the already-fetched remote: `git log`, `git tag`, `git merge-base`, `git describe`.
- `gh api` on a REST endpoint is a read in exactly two shapes: bare, carrying no `-f`/`-F`, no `--input`, and no `--method`/`-X`, as in `gh api repos/pingdotgg/t3code/issues/5779/timeline --paginate`; or with `--method GET` written out whenever the call carries any parameter at all, as in `gh api repos/pingdotgg/t3code/issues --method GET -f state=closed -f per_page=2`. Drop that `--method GET` and the same flags POST to the endpoint, which is an issue the fork just opened upstream.
- `gh api graphql` is the one exception, because GraphQL is POST by design and `-f` there sets variables rather than a REST body. It is allowed only for an operation whose keyword is `query`, and never for a `mutation`. The operation keyword is what makes it a read, so read the operation before you run it.
- Never against upstream: `gh issue create`, `gh issue comment`, `gh issue edit`, `gh pr create`, `gh pr review`, `gh pr comment`, `gh api graphql` running a `mutation`, any `gh api --method` or `-X` other than `GET`, any REST `gh api` carrying `-f`/`-F` without an explicit `--method GET`, any `gh api --input` at all, any `ghb` publish including `ghb issue create`, `ghb issue edit`, and `ghb gh`, and `git push upstream`.
- Fork-only writes: `ghb issue create` and `ghb issue edit` are the only publishing commands this skill runs, and both name `RSI-Software/t3code-hyprws`.
- Local-only, safe anywhere: `wt switch`, `wt list`, `wt remove`, `jq`, `git rev-parse`, and `git rebase`. A trial worktree is local and is never pushed.
- Re-read the target repository on every publishing command before you run it. `ghb issue create` takes it as `--repo`; `ghb issue edit` takes it inside the `OWNER/REPO#N` selector. Fork writes name `RSI-Software/t3code-hyprws`, and nothing this skill produces writes anywhere else.
- Survey mode is stricter still: it publishes nothing. No upstream call that is not a read, no fork issue, no tracked file changed. Its only output is a report file outside the tracked tree. It does run `git fetch upstream --tags`, which updates this clone's remote-tracking refs, tags, and `FETCH_HEAD`. That is a local write, it sends nothing upstream, and it is required rather than optional: `git tag --contains` answers out of local refs, so an unfetched clone names the wrong tag or none at all.

## Re-check a watched item

An `upstream-watch` issue is not finished work. Re-run its hunt and classification at each upstream rebase, update the citation's state and dates, and close it only once the fix is verified in a fork release.

## Troubleshoot predictably

- Empty search results usually mean the phrase is too long. Cut it to two or three words and search again.
- Too many results: search by the file path the symptom touches instead of its words.
- A best match closed as a duplicate: follow its state reason and timeline to the canonical issue, and cite that one.
- A pull request that looks merged but has a null `mergedAt` was closed unmerged. It is not a fix.
- No tag contains a merge commit: fetch upstream tags first. If still nothing, the fix merged after the newest tag; classify it merged, untagged and take that route under [Merged](#merged) rather than naming a tag.
- A "first stable tag" that is not one: a non-version tag such as `desktop-preview`, a prerelease such as `v0.0.4-alpha.1` or any `-nightly.`, or a fork tag such as `v0.0.34-hyprws.4`. The tag command lost the stable-tag shape from the reference recipe, which matches `v<major>.<minor>.<patch>` and nothing else. A prerelease is the dangerous one, because it looks like an answer while no stable release carries the fix at all. Naming a nightly is a separate and deliberate move, taken under [Merged](#merged); the tag command never hands you one by accident.
- A survey window that does not match the last survey's: `SINCE` is derived from the fork's upstream base commit, so it moves at every rebase, and that is the design rather than a bug. A window typed by hand is a deliberate widening, and the header has to say so and name the derived date.
- A survey section that claims a window a surface never filtered on: bind the window once and pass it to every sweep, as the reference file's sweep block does. A header is a claim about the commands, not a wish.
- `gh issue list --search` returning nothing on a phrase that plainly exists: a multi-word phrase in front of a qualifier needs its own quotes. `'"github issue" in:title'`, not `"github issue in:title"`.
- A survey where issues look empty: requests are in Discussions, not issues. Sweep them over GraphQL before reporting a gap.
- Discussion search returning off-domain threads: its ranking is loose. Read every title and drop the misses by hand rather than reporting them.
- Several live pull requests claim the same issue: cite them all on the fork issue and trial the newest, since upstream has not picked one either.
