# Fork development

> Fork-wide development discipline for `RSI-Software/t3code-hyprws`.

[Fork delta](./fork-delta.md) owns each domain's need, shape, and retirement.
`AGENTS.md` owns the no-post rule, trailers, and rebase-only topology.

Goal: a small, durable patch stack on upstream.

## Before adding to the fork

1. Run `vp run fork:scan --no-typecheck`.
2. Read its lesson ref, SHA, and freshness.
3. Prefer one adapter boundary over scattered edits.

Before changing a seam's path, subject, or split, run `node scripts/fork-churn.ts record`.
The [churn ledger](../operations/fork-sync.md#churn-ledger) owns seam identity, evidence, and blocking rules.

## Non-goals

| Never               | Detail                                |
| ------------------- | ------------------------------------- |
| Per-window backend  | No separate server, database, or auth |
| Second frontend     | No desktop-only copy of the web app   |
| Compositor policy   | No workspace policy inside T3 Code    |
| Removal             | Keep hub, remote, web, mobile         |
| Gratuitous rewrites | No rewrites for fork flavour          |

`dev:desktop:agent` is the one tooling exception; shipped launches leave placement to Hyprland.

## Multi-surface rule

`AGENTS.md` owns the surface walk. Two fork-specific rules:

- **Scoped ref:** resolves in every mode
- **Project ID:** never globally unique, never local

## Testing a fork checkout

`vp run dev:app` launches; [Scripts](./scripts.md#dev-app-surfaces) owns flags and state.

- **Explore:** base checkout
- **Implement:** a worktree
- **UAT:** checkout pinned to the SHA
- **One home per checkout:** stop before switching
- **Fixture:** never reset `.t3/test-project`

## Repository model

| Remote     | Repository                   | Purpose                       |
| ---------- | ---------------------------- | ----------------------------- |
| `upstream` | `pingdotgg/t3code`           | Canonical history, fetch only |
| `origin`   | `RSI-Software/t3code-hyprws` | Fork branches, published      |

Local `main` mirrors `upstream/main`, pushed fast-forward only.
`hyprws` is the single trunk, every domain in one rebased stack.
Domains are not branches: a commit declares one with `Fork-Domain`.

### Rejected alternatives

| Alternative              | Why rejected                                   |
| ------------------------ | ---------------------------------------------- |
| **Patch directory**      | Loses 3-way merge, rerere, blame, bisect, CI   |
| **Merge-based tracking** | `log base..hyprws` stops enumerating the delta |
| **Per-domain branches**  | One rebase per domain per sync                 |
| **jj / stacked diffs**   | Change-IDs fit; maturity does not              |
| **Vendored upstream**    | Inverts authority, maximizes entanglement      |
| **Plugin architecture**  | No upstream API; no-post forbids one           |
| **Full divergence**      | Wrong while the fork wants upstream's future   |

### Extracting a domain

```bash
git switch -c extract/project-windows upstream/main
git cherry-pick $(vp run fork:delta --domain project-windows --shas)
```

A conflict means the domain shares code with another.
Resolve it there, then record the seam in that domain's rebase scan.

| Rule                      | Detail                          |
| ------------------------- | ------------------------------- |
| One domain per commit     | Two domains means two lanes     |
| New code in its own files | Shared edits appear in the scan |
| Contiguous commits        | The replay never interleaves    |

### Stack order

Superseded-upstream first, fork-specific last:

1. `upstream-fixes`
2. `fork-meta` docs and tooling
3. Product domains, commits contiguous

A generic fix in no product domain is `upstream-fixes`.
New commits land on top and move down at the next rebase.
Reorder only on a clean stack; publish with a lease.

### Lanes

```bash
wt switch --create <branch> --base hyprws          # fork-specific work
wt switch --create <branch> --base upstream/main   # no fork dependencies
```

An `upstream/main` base keeps a commit removable, never a route upstream.

### Landing

Land onto `hyprws` by squash; a merge commit breaks the stack.

- **Pull request:** one is open or expected
- **`wt merge hyprws`:** explicit local landing
- **Direct to `hyprws`:** a `fork-meta` chore
- **Never raw `git merge`:** bypasses both

`ghb pr merge` squashes with the PR title and body, so end it with trailers.
`.github/workflows/hyprws-ci.yml` is the required check.
Non-linear movement voids a walk ([fold rule](../operations/fork-sync.md#the-fold-rule)).

## Upstream citations

A live cross-repo reference posts on somebody else's issue.

| Case                   | Form                                     |
| ---------------------- | ---------------------------------------- |
| Inline upstream item   | Code span: `` `pingdotgg/t3code#4379` `` |
| Pasted upstream survey | One fenced block                         |
| Fork item              | Full `RSI-Software/t3code-hyprws#108`    |
| Bare `#108`            | A finding; GitHub resolves it upstream   |

Run `vp run fork:upstream-refs <file>` before publishing; [Scripts](./scripts.md#upstream-reference-guard) owns coverage.

## Commit discipline

A seam commit carries one small intent; intent re-derives the resolution.

| Rule                              | Detail                               |
| --------------------------------- | ------------------------------------ |
| One concern per commit            | Conventional commit style            |
| Split mechanical from behavioural | Refactors apart from behavior        |
| No drive-by churn                 | No stray formatting, renames, bumps  |
| Narrow additions                  | Prefer upstream extension points     |
| Upstream vocabulary               | New terms only for new fork concepts |
| Tests beside behavior             | Keeps a resolution checkable         |
| Frozen installs                   | `vp i --frozen-lockfile`; own commit |

Fork-only paths need no granularity curation.

### Never squash a landed stack

Both exceptions are spent; each needed a lease and an archive ref.

| Exception                                       | Shape                                                |
| ----------------------------------------------- | ---------------------------------------------------- |
| Domain flatten (RSI-Software/t3code-hyprws#671) | One-time squash, churn aliases recorded first        |
| Reshape fold (RSI-Software/t3code-hyprws#965)   | `fork:sync fold-reshape` folds a landed reshape home |

A walk repair for one replayed commit is a trailer-free `fixup!`, autosquashed before the leased push.

### Ledger guards run in the scan

An action the churn ledger records ships its guard in the same change.

| Guard             | Fires when                                     |
| ----------------- | ---------------------------------------------- |
| `hot-seam`        | Edits a retained hot seam or repeated path     |
| `upstream-test`   | Test block outside the `.fork.test.ts` sibling |
| `footprint`       | More than six upstream files in one commit     |
| `replaced-export` | Deletes an upstream export, re-declares it     |
| `lockfile`        | Changes a lockfile, which no domain owns       |

| Flag                | Effect                                |
| ------------------- | ------------------------------------- |
| default             | Warnings advisory                     |
| `--strict`          | All fatal                             |
| `--since <ref>`     | Later commits; authoring guards fatal |
| `--replay-of <ref>` | Advisory again, proved rehearsal      |

Matchers live in `scripts/fork-scan-guards.ts`.

### Workflow copies require an explicit review

`workflow-drift` blocks `fork:scan`, including inside `fork:sync unblock-check`.
A review in `.github/fork-workflow-reviews.json` binds upstream commit and blob, fork blob, and an `adapted` or `no-change` rationale.

| Fingerprint     | Command                                  |
| --------------- | ---------------------------------------- |
| Upstream blob   | `git rev-parse <target>:<upstream-path>` |
| Upstream commit | `git rev-parse <target>^{commit}`        |
| Fork blob       | `git rev-parse HEAD:<fork-path>`         |
| Pending edit    | `git hash-object <fork-path>`            |

- **Adapt:** every job, before tests or builds
- **State:** a reason per fork choice
- **Commit:** workflow and manifest together
- **Rerun:** `fork:scan --target <target>`
- **Fork-only edit:** new blob, no new tag
- **Stale evidence:** fails the gate

### Fork tests live in fork-owned files

Fork-authored test blocks go in `<name>.fork.test.ts`, never appended upstream.
Otherwise the replay conflicts at one seam on every upstream append.

| Rule          | Detail                                                |
| ------------- | ----------------------------------------------------- |
| Append only   | A fork commit may only append upstream                |
| `fork:scan`   | Refuses a changed or removed line                     |
| Additive gate | A dropped line in the replay is a finding             |
| Baseline      | `editedInPlace` in `scripts/fork-test-debt.json`      |
| Ownership     | The selected upstream target tree                     |
| Recognized    | `it`, `test`, `describe`, `effectIt`, Effect variants |

Two harness deferrals, exact paths, never widened:

```text
apps/desktop/src/window/DesktopWindow.test.ts
apps/server/src/server.test.ts
```

Both build the harness in-module; a sibling would re-register every test.

### Diverging from an upstream expectation

The sibling rule is unconditional; an inconvenient test is not divergence.
Genuine divergence is two sibling parts, neither editing the upstream assertion.

```ts
// In the sibling, never in the upstream file:
forkSupersedes({
  upstream: "<upstream path> > <test name>",
  reason: "<why fork behavior differs>",
  commit: "<fork-commit-sha>",
});
```

Never `it.skip`, a comment-out, or an in-place edit: a bare skip loses an assertion unnoticed.
RSI-Software/t3code-hyprws#716 owns the parser; write the declaration anyway.

**Retiring one.** When upstream adopts the behavior, delete the declaration and its contradicting sibling case in the same change.
The upstream file needs no repair, because it never changed, and a sibling whose declaration is gone is a contradiction waiting for the next suite run.

### Extend an upstream export, do not replace it

An upstream export the fork needs more of stays where upstream declares it.
Re-declaring it drops every later upstream edit; the rebase replays the fork's copy.
Import it into a fork-owned sibling, compose beside it, export under a fork-owned name.

## Verification standard

- **Always:** targeted tests, lint, types
- **Backend behavior:** focused tests for it
- **Material change:** the production build

Visible or stateful behavior needs one permitted pass in a real client.

## Decision filter

Prefer the option that adds the least permanent machinery.
Reject a shortcut that hardens rebases, duplicates state, or breaks a surface.
The fork is healthy when its behavior is distinctive and its diff is boring.
