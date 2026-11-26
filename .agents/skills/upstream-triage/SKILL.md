---
name: upstream-triage
description: Read upstream pingdotgg/t3code from the t3code-hyprws fork without posting to it, in two modes. Triage one symptom felt in the fork build into one upstream citation, one classification of merged, merged but untagged, pending pull request, draft, issue only, or unknown, and one fork action, handing every upstream-facing sentence to the human as a saved suggestion. Or survey one fork domain into a dated report that sorts every upstream item into one state and one kind and maps it to one fork follow-up, writing nothing to GitHub. Use when a fork build misbehaves, before filing a fork bug issue, when choosing between a fork fix and a rebase, when re-checking an upstream-watch issue, when asking what upstream is doing in a fork domain, or when an agent is about to write anything aimed at upstream.
---

# Upstream triage

**Agents never post to `pingdotgg/t3code`**: no issues, pull requests, comments, reviews, or reactions.
Reads are fine; **the human posts**.

Two modes share the hunt commands, the class vocabulary, the citation format, and that rule:

- Triage: **one symptom**; one citation, class, action
- Survey: **one fork domain**; one dated report

Both end at [the suggestion hand-over](#hand-upstream-facing-text-over) and obey [the read-only boundary](#read-only-boundary).

## Frame the symptom

1. **Write one sentence** a stranger could reproduce
2. **Record the fork release** it appeared on
3. **Name** surface, connection mode, provider
4. **Walk** the domain's rebase scan
5. **Pick** two to four three-word phrases

A match must cover **the same surface, mode, and provider**.
The rebase scan in [Fork delta](../../../docs/fork/internals/fork-delta.md) says **whether a fork patch owns the seam**; say so, and keep triaging.
GitHub search misses long prose, so **three words beat a sentence**.

## Hunt upstream

Run [the search recipes](references/upstream-search.md) in this order; **stop at the first clearly canonical item**:

1. **Issues** on each phrase
2. **Pull requests** on the same phrases
3. Then **the file path** the symptom touches
4. The best issue's **timeline**
5. **Merged history** if nothing open matches

The timeline shows **claiming pull requests and duplicate chains**, often items the phrase search missed.

Keep:

- **Oldest issue** the rest duplicate
- **Newest live** pull request
- **Every live candidate**, not the first
- **Number, title, state**, both dates
- Merged: **merge commit and first stable tag**

## Classify

| Signal on the fix candidate     | Class          |
| ------------------------------- | -------------- |
| PR has a non-null `mergedAt`    | **merged**     |
| PR open, not a draft            | **PR pending** |
| PR open, a draft                | **draft**      |
| Issue; every PR closed unmerged | **issue only** |
| No upstream issue or PR         | **unknown**    |

- **Read `isDraft`**, never the title
- Closed unmerged is **not a fix**
- Merged, no stable tag yet: **still merged**
- Already in the fork's base: **unknown**

Already in the base means **the symptom is something else**.

## Fork action per class

### Merged

**Resolve the first stable tag** containing the merge commit, verify the fix on it, and file a fork issue to **rebase onto that tag**.
**Never carry a fork patch** for a fix one rebase away.

#### Merged, untagged

No upstream release carries it; **never name a tag that does not exist**.

- **Cite** merge commit and merge date
- **File** an `upstream-watch` fork issue
- **Rebase** onto the next stable tag
- **Re-check** at every rebase
- **Name the tag** once one exists

When it **blocks work** before that tag, name the **nightly tag** that contains it, the exception [Fork development](../../../docs/fork/internals/fork-development.md) allows.
**Fix under `upstream-fixes`** only when no tag contains it, small enough to drop on the real fix's rebase.

### PR pending

**Choose one route** and say why:

- Watch: **likely to land**, symptom tolerable
- Trial: the symptom **blocks work**

A watch is an `upstream-watch` fork issue with the citation, its state and dates, and what the fork does meanwhile.
A trial **rebases the PR head onto `hyprws`** in its own worktree, per [the reference](references/upstream-search.md#trial-a-pending-pull-request), and records **adopt, adapt, or reject** on the fork issue.
**Never push** a trial branch near upstream or comment on the PR; findings become a suggestion.

### Draft

Upstream is saying **the fix is not ready**: the fork neither waits on it nor adopts it.

- **File** an `upstream-watch` fork issue
- **Say plainly** it is a draft
- **Take** the issue only action
- **Trial** only when the fork fix is large
- **Note** a draft head can be rewritten or abandoned

Re-check reclassifies: **ready** becomes PR pending, **closed unmerged** issue only, **merged** merged.

### Issue only

**File or update** an `upstream-watch` fork issue carrying the citation.
**Fix in the fork only when it blocks work**: `Fork-Domain: upstream-fixes`, `Fork-Tier: bugfix`, `Fork-Upstreamable: yes`, small enough to drop when upstream lands its own.
When the fork's reproduction adds something, **draft a comment** for the human.

### Unknown

**Fix under `upstream-fixes`** when it blocks work.
Otherwise file with class `unknown`, `Upstream: none found`, and **the exact phrases searched**, so the next pass repeats them.
Then **draft an upstream bug report** for the human.

## File the fork issue

The body carries:

```text
Origin: the fork symptom you were working on, and the command or evidence that exposed it.
Symptom, and the fork release it appeared on.
Upstream: `pingdotgg/t3code#NNNN`, <state>, opened <date>, last updated <date>.
  Unknown class: write `Upstream: none found` and list the exact search phrases you ran, one per line.
  Merged, untagged: cite the merge commit and its merge date where the tag would go.
Classification: merged | merged, untagged | PR pending | draft | issue only | unknown.
Fork action: rebase target, watch, trial, or fork fix, with how it gets verified.
```

**Every upstream number is a code span**: `` `pingdotgg/t3code#4379` ``.
A bare number or plain URL **fires a cross-reference** upstream, a post the fork never meant.

File through the **`linear` skill**, as the user, in team `RSI`:

1. **Search** by repo label and symptom words
2. Match: **update its body**; never file a replacement
3. No match: **`save_issue`**, state **Triage**

Labels: `Bug`, `RSI-Software/t3code-hyprws`, `agent-filed`.
Priority **High only when it blocks work**.

An `upstream-watch` issue is one whose body says **`Fork action: watch`**; Linear has no such label.
It covers the classes that wait: **merged, untagged**, **PR pending**, **draft**, **issue only**.

## Survey a domain

A survey answers **"what is upstream doing in this area"**: shipped, in progress, and turned down.
It **posts nothing**: no upstream item, fork issue, or tracked file; the human picks the follow-ups.
Its only writes are **the report file** outside the tracked tree and **`git fetch upstream --tags`**, required so tag containment answers truly.

### Header first

Record the header **before searching**; a reader must never guess how stale it is:

- Repository: **`pingdotgg/t3code`**, always named
- Fork base: **stable tag** holding the merge base
- Latest stable: **newest stable tag**, its date
- Survey date: **the day** the sweeps ran
- Window: **the derived `SINCE`**, on last activity
- Surfaces: **only the sweeps** that ran
- Truncation: **each capped sweep**, and the raise
- Phrases and paths: **exact**, for the next survey

A hand-widened window **says so** and names the derived date.
A surface that **could not honor the window** narrows the header and goes in `Gaps`.
A sweep that hit its limit and **does not say so** is worse than none.

### Sweep every surface

Take the domain from `FORK_DOMAINS`, its **rebase-scan paths**, and three to five short phrases.
Run [Sweep a whole domain](references/upstream-search.md#sweep-a-whole-domain) and [Fix the freshness boundary](references/upstream-search.md#fix-the-freshness-boundary).
Unlike triage, a survey **never stops at the first match**:

- **Issues**, pull requests, discussions
- **Release contents** and path history
- **Once per phrase**, never once in total
- **Timelines** of anything central
- **Number, title, kind, state**, dates
- Merged: **merge commit and first stable tag**

**An item without dates** stays out of the report.

### States

**Take the first matching row**; every item gets exactly one.
**declined** sits above **open**, so a refusal on an open item reads as a refusal; **resolved** is the catch-all.

| State                | Signal                               |
| -------------------- | ------------------------------------ |
| **shipped**          | Merged; a stable tag contains it     |
| **merged, untagged** | Merged; no stable tag yet            |
| **declined**         | Upstream refused it, open or closed  |
| **withdrawn**        | Closed unmerged, no upstream verdict |
| **draft**            | PR open, `isDraft: true`             |
| **open**             | Open PR, issue, or discussion        |
| **resolved**         | Any other closed item                |

Declined signals:

- Issue closed **`NOT_PLANNED`**
- Discussion closed **`OUTDATED`**
- A **`wontfix`** label
- A maintainer **closing another's PR** over the change
- A maintainer's **written refusal** on an open item

Withdrawn signals:

- The **author closed** their own PR
- Closed **as a duplicate**: report the canonical

Resolved: issue **`COMPLETED`** with no closing PR, or discussion **`RESOLVED`**.

Phrase each state by its strength:

- shipped: **"upstream has ..."**
- merged, untagged: "**unreleased since** `<tag>`"
- declined: **"upstream declined ..."**
- withdrawn: "upstream **never ruled**"
- draft: "upstream **has a draft** ..."
- open: "upstream **is considering** ..."
- resolved: "closed as done; **no merge commit** cited"

### Kinds

Kind is **a second axis**: a fixed defect and a new feature are different news.

| Kind             | Signal                                             |
| ---------------- | -------------------------------------------------- |
| **defect**       | `[Bug]:` issue, `fix(...)` PR                      |
| **feature**      | `[Feature]:` item, `feat(...)` PR                  |
| **performance**  | `perf(...)` PR                                     |
| **internal**     | `docs`, `chore`, `refactor`, `test`, `build`, `ci` |
| **unclassified** | None of the above, even after reading the change   |

- Performance: **gained by rebasing**, so not defect
- Internal: **no behaviour**; only collisions matter
- Unprefixed: **take the row it behaves like**

### Honesty rules

- **Read `isDraft`**, never the title
- **Closed discussion** is not declined
- **`DUPLICATE`** is no verdict: follow it
- **Closed unmerged** is not declined
- Declined but open: **say it is open**
- **Never name** a tag that does not exist
- **Never "will ship"**; only "has", "considering"
- **Before resolved**, read timeline cross-references

An `Ideas` thread is **a request**, however many upvotes.

### Map every item onto the fork

Match each item to the domain it touches **through the rebase scans**; take **the first matching follow-up**:

| Follow-up         | When                                       |
| ----------------- | ------------------------------------------ |
| **rebase target** | shipped, not yet carried, and wanted       |
| **trial**         | open or draft, wanted now                  |
| **watch**         | merged untagged, or open the fork waits on |
| **fork fix**      | nothing to rebase onto; fork needs it      |
| **note only**     | in a domain, nothing to do                 |
| **nothing**       | touches no fork domain                     |

- Wanted: it **retires or collides** with delta
- Wanted: or **adds behaviour** the fork wants
- Not yet carried: **`git merge-base --is-ancestor`**
- **Only rebase target** names a tag
- **Note only** names the domain and why
- **Nothing** is a finding: say it explicitly
- **Watch proposes** an `upstream-watch` issue
- A survey **never files**
- Retirement met: **the most valuable find**

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

An empty section **says so in one line**; an empty `Declined` is a finding.
**Code-span every upstream reference**, tables and `Gaps` included: a survey cites dozens.
Save to `.dump/upstream-surveys/<domain>-<date>.md` when that directory exists, else where the user names; **never commit it**.
It is a dated snapshot: **the next survey writes a new file**.

## Hand upstream-facing text over

Anything aimed at upstream is **produced, never posted**:

1. **Write** the full title and body, or comment
2. **Save** it outside the tracked tree
3. **Show** it in chat with target and path
4. **Say** the human posts it
5. **Record** a declined post on the fork issue

Save to `.dump/upstream-drafts/<slug>.md` when that directory exists, else where the user names; **never commit it**.
Draft **in upstream's voice**: their template and terms, no fork branding or paths, a reproduction on an upstream build.
A reproduction that **needs the fork** is a fork defect: stop.

## Read-only boundary

### Effective method decides

A call is a read by its **effective HTTP method**, not the flags it spells out.
Per `gh api --help`, any **`-f`/`-F` switches the method to `POST`**; a `-X` rule alone never sees that.
**`--input` sends a body**, so it is a write whatever the method.

A REST call is a read in **exactly two shapes**:

- **Bare**, with no `-f`/`-F`, `--input`, or `-X`
- **`--method GET`** whenever it has a parameter

`gh api graphql` is the exception: **`query` operations only**, never a `mutation`; read the operation first.

### Allowed against upstream

- `gh issue`: **`view`, `list`**
- `gh pr`: **`view`, `list`, `diff`, `checkout`**
- `gh release`: **`list`, `view`**
- **`gh search`** and **`git fetch upstream`**
- Local git: **`log`, `tag`, `merge-base`**

`gh pr checkout --force` **rewrites only a local branch**.

### Never against upstream

- `gh issue`: **`create`, `comment`, `edit`**
- `gh pr`: **`create`, `review`, `comment`**
- GraphQL: **any `mutation`**
- REST: **any `-X` but `GET`**
- REST: **`-f`/`-F` without `--method GET`**
- **`gh api --input`** and **`git push`**

### Fork writes

**Linear `save_issue` is the only write** triage makes; a survey makes none.
Local and safe: `wt switch`, `wt list`, `wt remove`, `jq`, `git rev-parse`, `git rebase`.
**A trial worktree is never pushed.**

## Re-check a watched item

An `upstream-watch` issue is **not finished work**.
At each upstream rebase, **rerun its hunt and class**, update the citation, and close it only once **the fix is verified in a fork release**.

## Troubleshoot

| Symptom                     | Fix                                  |
| --------------------------- | ------------------------------------ |
| Empty results               | Cut the phrase to two or three words |
| Too many results            | Search by file path                  |
| Duplicate best match        | Follow it to the canonical issue     |
| Looks merged, no `mergedAt` | Closed unmerged; not a fix           |
| No tag contains it          | Fetch tags; else merged, untagged    |
| Bad first stable tag        | Restore the stable-shape `grep`      |
| Window moved                | By design: `SINCE` tracks the base   |
| Unenforced window           | Bind `SINCE` once, pass it to all    |
| `--search` finds nothing    | Quote the phrase before a qualifier  |
| Issues look empty           | Requests live in Discussions         |
| Off-domain discussions      | Drop misses by title                 |
| Several PRs claim one issue | Cite all; trial the newest           |

A bad first stable tag is a **non-version tag** (`desktop-preview`), a **prerelease** (`-alpha.`, `-nightly.`), or a **fork tag** (`-hyprws.`); the prerelease is dangerous, as it looks like an answer.
