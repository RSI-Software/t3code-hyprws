---
name: upstream-triage
description: Triage a bug felt in the t3code-hyprws fork build against upstream pingdotgg/t3code before the fork acts on it, classify it as merged, merged but untagged, pending pull request, draft, issue only, or unknown, take the matching fork action, and hand every upstream-facing sentence to the human as a saved suggestion instead of posting it. Use when a fork build misbehaves, before filing a fork bug issue, when deciding whether to fix in the fork or wait for a rebase, when re-checking an upstream-watch issue, or when an agent is about to write anything aimed at upstream.
---

# Upstream triage

One rule outranks everything else in this skill: **agents never post to `pingdotgg/t3code`**.
No issues, pull requests, comments, reviews, or reactions. Reads are fine. The human posts.

Everything below turns a symptom felt in the fork build into one canonical upstream citation, one classification, and one fork action.

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

## Hand upstream-facing text over as a suggestion

Anything aimed at upstream — a bug report, a reproduction, a comment on a pull request — is produced, never posted.

1. Write the complete text: a title and body for a new report, or the exact comment.
2. Save it outside the tracked tree, in `.dump/upstream-drafts/<slug>.md` when that scratch directory exists, otherwise in a path the user names. Never commit it.
3. Show the complete text in chat with its target (`pingdotgg/t3code#NNNN`, or "new issue") and the saved path, and say plainly that the human posts it.
4. If the human declines to post, record on the fork issue that the upstream report is deliberately unposted.

Draft in upstream's voice: their issue template, their terminology, no fork branding, no fork-only paths, and a reproduction that runs on an upstream build. If the only reproduction needs the fork, stop — that is a fork defect, not an upstream report.

## Stay inside the read-only boundary

- What makes a call a read is the method it actually sends, not the flag you typed. `gh api` defaults to GET, but any `-f`, `-F`, or `--input` silently switches it to POST, so a parameterised upstream read must say `--method GET`, which sends those parameters as a query string. GraphQL is the one exception: `gh api graphql` always POSTs, and what keeps it a read is the document — `-f query='query { ... }'` reads, and a `mutation` writes however it is spelled.
- Allowed against upstream: `gh issue view`, `gh issue list`, `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checkout` including `--force`, which rewrites only a local branch, `gh search`, any `gh api` that sends GET, `gh api graphql` carrying a `query`, and `git fetch upstream`. `gh pr checkout` only writes to the local worktree.
- Never against upstream: `gh issue create`, `gh issue comment`, `gh issue edit`, `gh pr create`, `gh pr review`, `gh pr comment`, any REST `gh api` sending a method other than GET, whether from `--method`, `-X`, or the POST that `-f`, `-F`, or `--input` turns on, any `gh api graphql` carrying a `mutation`, any `ghb` publish including `ghb issue create`, `ghb issue edit`, and `ghb gh`, and `git push upstream`.
- Fork-only writes: `ghb issue create` and `ghb issue edit` are the only publishing commands this skill runs, and both name `RSI-Software/t3code-hyprws`.
- Local-only, safe anywhere: `wt switch`, `wt list`, `wt remove`, `jq`, `git rev-parse`, `git rebase`, `git tag --contains`, and `git merge-base`. A trial worktree is local and is never pushed.
- Re-read the target repository on every publishing command before you run it. `ghb issue create` takes it as `--repo`; `ghb issue edit` takes it inside the `OWNER/REPO#N` selector. Fork writes name `RSI-Software/t3code-hyprws`, and nothing this skill produces writes anywhere else.

## Re-check a watched item

An `upstream-watch` issue is not finished work. Re-run its hunt and classification at each upstream rebase, update the citation's state and dates, and close it only once the fix is verified in a fork release.

## Troubleshoot predictably

- Empty search results usually mean the phrase is too long. Cut it to two or three words and search again.
- Too many results: search by the file path the symptom touches instead of its words.
- A best match closed as a duplicate: follow its state reason and timeline to the canonical issue, and cite that one.
- A pull request that looks merged but has a null `mergedAt` was closed unmerged. It is not a fix.
- No tag contains a merge commit: fetch upstream tags first. If still nothing, the fix merged after the newest tag; classify it merged, untagged and take that route under [Merged](#merged) rather than naming a tag.
- Several live pull requests claim the same issue: cite them all on the fork issue and trial the newest, since upstream has not picked one either.
