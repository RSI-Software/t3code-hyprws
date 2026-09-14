# Fork development

> Fork-wide development discipline for `RSI-Software/t3code-hyprws`.

[Fork delta](./fork-delta.md) owns each domain's **need, shape, and retirement**.
`AGENTS.md` owns the **no-post rule, trailers, and rebase-only topology**.
[Fork sync](../operations/fork-sync.md) owns **sync mechanics**.

## Before adding to the fork

1. Run `vp run fork:scan --no-typecheck`
2. **Prefer one adapter boundary** over scattered edits

The fork **never adds**:

- A **per-window backend**, database, or auth
- A **desktop-only copy** of the web app
- **Workspace policy** inside T3 Code
- **Window kinds**; every window shows any project
- **Removal** of remote, web, or the upstream app
- **Rewrites** for fork flavour

## Wire compatibility

`AGENTS.md` owns the surface walk and the **stock-app rule**.

- A **scoped ref resolves** in every mode
- A **project ID** is never globally unique, never local
- Fork **fields are optional**; upstream drops them
- Fork **capabilities are optional** flags
- An **absent capability** means unsupported
- **No fork event type** on an upstream-decoded stream
- **No fork literal** in an upstream slot
- A **`...Fork` sibling key** holds fork literals

`scripts/upstream-client-compat.fork.test.ts` **decodes fork payloads** with the upstream base contracts.

## Testing a fork checkout

`vp run dev` launches; [Development](../../operations/development.md#state-and-ports) owns state and ports.
Nothing opens a browser; agents **place windows through `donjor hypr`**.

- **Explore** in the base checkout
- **Implement** in a worktree
- **Verify a release** in a checkout pinned to its SHA
- **Stop dev** before switching a checkout's home

## Repository model

| Remote     | Repository                   | Purpose                       |
| ---------- | ---------------------------- | ----------------------------- |
| `upstream` | `pingdotgg/t3code`           | Canonical history, fetch only |
| `origin`   | `RSI-Software/t3code-hyprws` | Fork branches, published      |

Local `main` **mirrors `upstream/main`**, pushed fast-forward only.
With `upstream` present, `gh` refuses or targets `pingdotgg/t3code`; install **pins its default to the fork** (`scripts/fork-gh-default.ts`).
`hyprws` is the **single trunk**: every domain in one rebased stack.
**Domains are not branches**: a commit declares one with `Fork-Domain`.

### Extracting a domain

```bash
git switch -c extract/multi-window upstream/main
git cherry-pick $(node scripts/fork-delta.ts --domain multi-window --shas)
```

A conflict means the domain **shares code with another**: resolve it there, then record the seam in that domain's rebase scan.
That holds only while each domain keeps these:

- **One domain** per commit
- **New code in its own files**
- **Contiguous commits** per domain

### Stack order

**Superseded-upstream first**, fork-specific last:

1. `upstream-fixes`
2. `fork-meta` docs and tooling
3. Product domains, commits contiguous

A generic fix in no product domain is **`upstream-fixes`**.
New commits **land on top** and stay there; sync moves only a `fixup!`, beneath its owner.
**Reorder only on a clean stack**; publish with a lease.
A squash lists its members under **`Squashes:`**, one `- <sha> <subject>` line each plus **every PR reference** the member carried, so the rebase scan reads every member as a replay counterpart, by sha or else by subject.
A refold **keeps every link** an earlier fold gathered, bare `(#N)` markers included; `prove` refuses a fold that drops one.

### Branch bases

```bash
git fetch origin hyprws
wt switch --create <branch> --base origin/hyprws   # fork-specific work
wt switch --create <branch> --base upstream/main   # no fork dependencies
```

An `upstream/main` base keeps a commit **removable**, never a route upstream.
**Base on the fetched ref**, never local `hyprws`: a sync rewrites `origin/hyprws`, and worktree setup refuses a HEAD no remote-tracking ref contains.

### Landing

Land onto `hyprws` **by squash**; a merge commit breaks the stack and voids a sync run's lease.

- A **pull request** when one is open or due
- **`wt merge hyprws`** for an explicit local landing
- **Direct to `hyprws`** for `fork-meta` chores
- **Never raw `git merge`**

`ghb pr merge` squashes with the PR title and body, so **end the body with trailers**.
`hyprws-ci.yml` is the **required check**; `hyprws-body.yml` checks the body's trailers and citations, **advisory only**.

## Upstream citations

A **live cross-repo reference posts** on somebody else's issue.

- Inline upstream item: a **code span**
- Pasted upstream survey: **one fenced block**
- Fork item: **full** `RSI-Software/t3code-hyprws#108`
- Bare `#108`: a **finding**; it resolves upstream

Run **`vp run fork:upstream-refs <file>` before publishing**; [Scripts](./scripts.md#upstream-reference-guard) owns its coverage.

## Commit discipline

A seam commit carries **one small intent**; intent re-derives the resolution.

- **One concern** per conventional commit
- **Refactors apart** from behavior changes
- **No drive-by** formatting, renames, or bumps
- **Prefer upstream extension points**
- **Upstream vocabulary**; new terms for new ideas
- **Tests beside behavior**, so a resolution checks
- **Frozen installs**; bumps in their own commit

Install with **`vp i --frozen-lockfile`**.
Fork-only paths need **no granularity curation**.

### Fold to stay tight

**Fold ahead commits to one PR-sized intent each**: a feature absorbs its fixes and resolutions, so a seam conflicts once per replay, not once per commit.
The [`fork-fold`](../../../.agents/skills/fork-fold/SKILL.md) skill runs it **inside a sync session** and owns its gates.
Fold commits that **share one owning intent or cancel each other's upstream hunks**, never only because they share a domain.
A **cancelling pair across domains** cannot share a plan line: drop both hunks by hand at the fold, and `prove` checks the tree.

`fork:ci` refuses two shapes that pass at the tip but block the next sync.
[`fork:stale-delete`](../../../scripts/lib/fork-stale-delete.ts) refuses an **upstream line one commit deletes and a later one restores**.
[`fork:fixup-fold`](../../../scripts/fork-fixup-fold.ts) refuses a **`fixup!` that does not fold at its owner**.

### Fork tests live in fork-owned files

Fork test blocks go in **`<name>.fork.test.ts`**, never appended upstream; otherwise every upstream append conflicts at one seam.
A browser test **keeps its infix**: `<name>.browser.test.tsx` pairs with `<name>.fork.browser.test.tsx`, so the browser project still runs it.
The additive gate (`scripts/lib/fork-additive-gate.ts`) owns which test openers count, against the selected upstream target tree:

- A fork commit **only appends** to an upstream test
- A **dropped line** in the replay is a finding
- An **opener the target already has** is no fork block

### Diverging from an upstream expectation

The sibling rule is **unconditional**; an inconvenient test is not divergence.
**Genuine divergence** is two sibling parts, neither editing the upstream assertion.

```ts
// In the sibling, never in the upstream file:
import { forkSupersedes } from "../../../../../scripts/lib/fork-supersedes.ts";

forkSupersedes({
  upstream: "<upstream path> > <test name>",
  reason: "<why fork behavior differs>",
  commit: "<fork-commit-sha>",
});
```

The import is a **typed no-op**: `fork:scan` reads the declaration from the sibling's text and never runs it.
**Never `it.skip`**, comment out, or edit in place: a bare skip loses an assertion unnoticed.

`fork:scan` judges each declaration:

- A **missing field** fails the scan
- A **file or test the target lacks** fails it
- An **undeclared contradicting sibling**: finding
- A **declared upstream case**: superseded
- An **upstream case matching the fork**: retire

**Retire by deleting** the declaration and its sibling case in one change.

### Extend an upstream export, do not replace it

An upstream export the fork needs more of **stays where upstream declares it**; re-declaring it drops every later upstream edit.
**Import it into a fork-owned sibling**, compose beside it, and export under a fork-owned name.
