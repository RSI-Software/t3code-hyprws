# Fork development

> Fork-wide development discipline for `RSI-Software/t3code-hyprws`.

[Fork delta](./fork-delta.md) owns each domain's need, shape, and retirement.
`AGENTS.md` owns the no-post rule, trailers, and rebase-only topology.

Goal: a small, durable patch stack on upstream.

## Before adding to the fork

1. Run `vp run fork:scan --no-typecheck`.
2. Prefer one adapter boundary over scattered edits.

The sync driver's typed report is the only authority for sync state.
Published issue comments are projections of it: never parse one, and never treat an edit to one as a decision.

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
- **Verify a release:** checkout pinned to the SHA
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
| One domain per commit     | Two domains means two rebases   |     |
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
A squash lists its members under `Squashes:`, one `- <sha> <subject>` line each, so the rebase scan reads every member as a replay counterpart.

### Branch bases

```bash
git fetch origin hyprws
wt switch --create <branch> --base origin/hyprws   # fork-specific work
wt switch --create <branch> --base upstream/main   # no fork dependencies
```

An `upstream/main` base keeps a commit removable, never a route upstream.

A sync rebase rewrites `origin/hyprws`; the local `hyprws` keeps the old history.
Base on the fetched ref, never the local branch: discarded history survives on no remote, and worktree setup refuses a HEAD that no remote-tracking ref contains.

### Landing

Land onto `hyprws` by squash; a merge commit breaks the stack.

- **Pull request:** one is open or expected
- **`wt merge hyprws`:** explicit local landing
- **Direct to `hyprws`:** a `fork-meta` chore
- **Never raw `git merge`:** bypasses both

`ghb pr merge` squashes with the PR title and body, so end it with trailers.
`.github/workflows/hyprws-ci.yml` is the required check.
Non-linear movement onto `hyprws` voids a sync run's lease; the next run rebases over a merge commit the same way over any other base, which is exactly what the fork stack forbids.

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

Squashing flattens a domain's commits into one, and the delta table can no longer tell a fork commit from an upstream one.
The one-time flatten (RSI-Software/t3code-hyprws#671) predates the delta table and stays archived under a ref.
Do not repeat it.

### Fork tests live in fork-owned files

Fork-authored test blocks go in `<name>.fork.test.ts`, never appended upstream.
Otherwise the replay conflicts at one seam on every upstream append.

| Rule          | Detail                                                |
| ------------- | ----------------------------------------------------- |
| Append only   | A fork commit may only append upstream                |
| Additive gate | A dropped line in the replay is a finding             |
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
import { forkSupersedes } from "../../../../../scripts/lib/fork-supersedes.ts";

forkSupersedes({
  upstream: "<upstream path> > <test name>",
  reason: "<why fork behavior differs>",
  commit: "<fork-commit-sha>",
});
```

The import is a typed no-op: `fork:scan` reads the declaration from the
sibling's text and never runs it, while the import gives the call site a
binding typecheck accepts.

Never `it.skip`, a comment-out, or an in-place edit: a bare skip loses an assertion unnoticed.
The scan reads the declaration (`fork:scan`, step 4): a call missing `upstream`, `reason`, or `commit`, or naming an upstream file or test name the target tree does not carry, fails the scan, and a sibling case that contradicts its upstream counterpart with no declaration is a finding. A named upstream case reads as superseded rather than contradictory in the additive gate. A declaration whose upstream case has adopted the fork behaviour surfaces as a retire candidate on the pinned-target walk.

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
