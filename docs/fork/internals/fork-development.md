# Fork development

> Fork-wide development discipline for `RSI-Software/t3code-hyprws`.

[Fork delta](./fork-delta.md) owns each domain's need, shape, and retirement condition.
`AGENTS.md` owns the baseline this guide never restates: the no-post rule, required trailers, rebase-only topology.

Goal: a small, durable patch stack on top of upstream T3 Code.

## What the sync machinery is for

The bot carries most upstream tags alone.
An agent runs only when a walk stops at a real judgement: a retire question, or a behaviour seam.
A conflict reaching an agent is genuine new upstream work meeting new fork work, never a seam the churn ledger already named.

Before adding to the fork:

1. Run `vp run fork:scan --no-typecheck`.
2. Read its lesson ref, SHA, and freshness.
3. Read the latest sync report's `## Churn` section.
4. Prefer one adapter boundary over scattered edits.

Use `--offline` explicitly when working from retained evidence.
Success is consecutive tags carried with no agent stop (RSI-Software/t3code-hyprws#443).

### Seam identity

A hooked seam is keyed on its manifest keys, so a path or subject rewrite mints no new one.
Every other seam is keyed on path, subject, and domain.
An absent seam is only not observed, never an inferred repair, and a `v1` observation cannot show a `v2` seam absent.

Before changing a seam's path, subject, or patch split, store its census and reviewed aliases with `fork:churn record`.
A repair names its change and guard; a separate maintainer-attested verification names the comparable replay and guard result.
The [churn ledger](../operations/fork-sync.md#churn-ledger) owns census evidence, seam shapes, and the blocking rules.

## Project-window direction

The unit of desktop organization is a physical project in an environment.
Opening a project reveals its existing window or creates one scoped to it, from the hub, the CLI, or a Hyprland keybind.
The all-project hub survives.

Until desktop windows land, a browser app window on the project-scoped web route is an acceptable interim, served through portless for a stable named `.localhost` origin.
Hyprland owns placement, so T3 Code exposes normal windows and never becomes a window manager.

## Non-goals

| Never               | Detail                                         |
| ------------------- | ---------------------------------------------- |
| Per-window backend  | No separate server, database, runtime, or auth |
| Second frontend     | No desktop-only copy of the web app            |
| Compositor policy   | No workspace policy inside T3 Code             |
| Removal             | Keep the hub, remote environments, web, mobile |
| Gratuitous rewrites | No unrelated rewrites for fork flavour         |

`dev:desktop:agent` is the narrow development-tooling exception, relaying an explicit workspace request into a disposable dev process.
Shipped launches still leave placement to Hyprland.

## Testing a fork checkout

`vp run dev:app` is the shared launcher; [Scripts](./scripts.md#dev-app-surfaces) owns its flags and state directories.
Explore in the base checkout, implement in a worktree, and run UAT on a checkout pinned to the candidate SHA.
One backend owns one checkout-local `.t3` home at a time, so stop it before switching that checkout's surface.
Relaunches retain `.t3/test-project`; never reset that fixture or copy stable installation state into it.

## Multi-surface rule

Desktop gains operating-system windows; web keeps a project-scoped route that behaves correctly in a normal tab.
Mobile needs no window management, but behavior web and mobile share belongs in `packages/client-runtime`.
Local, remote, relay, and tunnel connections must resolve the same scoped project reference.
Never assume a project ID is globally unique or local.

## Repository model

| Remote     | Repository                   | Purpose                             |
| ---------- | ---------------------------- | ----------------------------------- |
| `upstream` | `pingdotgg/t3code`           | Canonical history, fetch only       |
| `origin`   | `RSI-Software/t3code-hyprws` | Fork branches and published history |

Run the [`upstream-triage`](../../../.agents/skills/upstream-triage/SKILL.md) skill before filing or fixing a bug felt in the fork build.

Local `main` mirrors `upstream/main` exactly, pushed to `origin` fast-forward only.
`hyprws` is the single fork trunk and default branch, holding every domain as one rebased stack.
Domains are not branches: a commit declares one with `Fork-Domain`, and `fork:delta` groups the stack by it.

### Extracting a domain

One trunk stays honest only while any single domain can leave it.

```bash
git switch -c extract/project-windows upstream/main
git cherry-pick $(vp run fork:delta --domain project-windows --shas)
```

SHAs come out in stack order, so the replay matches how the domain landed.
A conflict means the domain shares code with another: resolve it in the extract, then record the seam in that domain's rebase scan.

| Rule                      | Detail                                         |
| ------------------------- | ---------------------------------------------- |
| One domain per commit     | A commit serving two domains is two lanes      |
| New code in its own files | Every shared file it edits appears in the scan |
| Contiguous commits        | The replay never interleaves domains           |

### Stack order

Sorted from most likely to be superseded upstream to most fork-specific:

1. `upstream-fixes`
2. `fork-meta` docs and tooling
3. Product domains, commits contiguous

A generic fix belonging to no product domain is `upstream-fixes`; a domain's own bugfix stays in that domain.
New commits land on top and move down at the next rebase.
Reorder only when the stack is otherwise clean, and publish with a lease.

### Lanes

Short-lived branches isolate one concern.
Use `upstream/main` only for a fix that must carry no fork dependency, so a later rebase can drop it whole.
That base keeps the commit removable; it is not a route to contributing it upstream.

```bash
wt switch --create <branch> --base hyprws          # fork-specific work
wt switch --create <branch> --base upstream/main   # no fork dependencies
```

### Landing

Land a lane onto `hyprws` by squash, never by merge commit: a merge breaks the linear stack.
`ghb pr merge` takes the pull-request title as the subject and the body as the squash body, so title it as a conventional commit and end the body with the trailer block.

- **Pull request:** one is open or expected
- **`wt merge hyprws`:** explicit local landing
- **Direct to `hyprws`:** a `fork-meta` chore
- **Never raw `git merge`:** bypasses both

`.github/workflows/hyprws-ci.yml` is the fork's required check, and `ghb pr merge` refuses a stale merge ref.
A fork-sync walk folds linear landings on `hyprws`; non-linear movement voids the walk ([fold rule](../operations/fork-sync.md#the-fold-rule)).

## Upstream citations

GitHub turns a live cross-repo reference into an event on the item it names, posted from the fork's bot account.
The fork files nothing upstream, so that backlink is noise on somebody else's issue.
Neutralise the reference and leave the prose alone.

| Case                   | Form                                                       |
| ---------------------- | ---------------------------------------------------------- |
| Inline upstream item   | A code span: `` `pingdotgg/t3code#4379` ``                 |
| Pasted upstream survey | One fenced block around the list                           |
| Fork item              | Full `RSI-Software/t3code-hyprws#108`, rendering as `#108` |

A bare `#108` is a finding too, because GitHub resolves it against `pingdotgg/t3code`.
Run `vp run fork:upstream-refs <file>` before publishing; [Scripts](./scripts.md#upstream-reference-guard) owns the guard's coverage.

## Commit discipline

Every fork commit is a patch that may outlive hundreds of upstream commits.
A commit touching a seam carries one intent and stays small, because that intent re-derives the conflict resolution.
Inside fork-only paths, granularity needs no curation.

| Rule                              | Detail                                              |
| --------------------------------- | --------------------------------------------------- |
| One concern per commit            | Conventional commit style                           |
| Split mechanical from behavioural | Refactors apart from behavior changes               |
| No drive-by churn                 | No stray formatting, renames, or bumps              |
| Narrow additions                  | Prefer upstream-native extension points             |
| Upstream vocabulary               | New terms only for new fork concepts                |
| Tests beside behavior             | Keeps a resolution checkable                        |
| Frozen installs                   | `vp i --frozen-lockfile`; deps are their own commit |

### Never squash a landed stack

Once commits land, the stack is never squashed.
Two exceptions are spent, both tree-neutral and both under a human-authorized expected-old trunk lease with a verified archive ref created first.

| Exception                                       | Shape                                                |
| ----------------------------------------------- | ---------------------------------------------------- |
| Domain flatten (RSI-Software/t3code-hyprws#671) | One-time squash, churn aliases recorded first        |
| Reshape fold (RSI-Software/t3code-hyprws#965)   | `fork:sync fold-reshape` folds a landed reshape home |

See [Fork strategy principle 4](./fork-strategy.md#principles) for the asymmetry.
When a walk repair belongs to one replayed commit, write it as a trailer-free `fixup!` and autosquash before the leased push.

### Ledger guards run in the scan

An action the churn ledger records ships its guard in the same change, and the sub-issue naming that action names the guard.
A rule only prose states is a rule the next walk pays for again.
`vp run fork:scan` collects them over the fork stack:

| Guard             | Fires when                                               |
| ----------------- | -------------------------------------------------------- |
| `hot-seam`        | The commit edits a retained hot seam or repeated path    |
| `upstream-test`   | A test block lands outside the `.fork.test.ts` sibling   |
| `footprint`       | One commit edits more than six upstream files            |
| `replaced-export` | The commit deletes an upstream export and re-declares it |
| `lockfile`        | The commit changes a lockfile, which no domain owns      |

The inventory keeps every original [Fork churn](./fork-churn.md) path, including unmapped and unresolved lessons.
A missing path in a later snapshot, or a named guard, does not prove a historical repair.

General warnings are advisory; `--strict` makes all of them fatal.
`--since <ref>` narrows to later commits and makes adopted authoring guards fatal without `--strict`, while `--replay-of <ref>` returns them to advisory for a proved rebase rehearsal.
`AUTHORING_GUARD_TARGETS` in `scripts/fork-scan-guards.ts` supplies each adopted matcher's exact paths, and its invariant requires scoped guidance for every target, including retired ones.

### Workflow copies require an explicit review

`workflow-drift` is a blocking `fork:scan` check, including inside `fork:sync unblock-check`.
It compares upstream `ci.yml` and `release.yml` at the target with the reviews in `.github/fork-workflow-reviews.json` at the fork head.
Each review binds the upstream commit and blob, the fork blob, and an `adapted` or `no-change` rationale.
Checking reviewed blobs also catches drift after replay, when an overlap scan has no upstream delta left to see.

| Fingerprint          | Command                                  |
| -------------------- | ---------------------------------------- |
| Upstream source blob | `git rev-parse <target>:<upstream-path>` |
| Upstream full commit | `git rev-parse <target>^{commit}`        |
| Committed fork blob  | `git rev-parse HEAD:<fork-path>`         |
| Pending fork edit    | `git hash-object <fork-path>`            |

Adapt every job before tests or builds run, and state a reason for each deliberate fork choice.
Commit the reviewed workflow and manifest together, then rerun `fork:scan --target <target>`.
A fork-only edit needs a new fork blob and rationale, but no new upstream tag.
Missing, malformed, or stale review evidence fails the gate.

### Fork tests live in fork-owned files

Put fork-authored test blocks in `<name>.fork.test.ts` or `.tsx` beside the upstream test, never appended to the upstream file.
The replayed series otherwise conflicts at the same shared insertion seam every time upstream appends a test.

A fork commit may only append to an upstream test file.
`fork:scan` refuses a changed or removed line in an upstream case, and the additive gate counts a line the replayed tree no longer carries as a finding.
The baseline for both is the table in [`fork-test-divergence.md`](./fork-test-divergence.md), not a second list beside it.

Ownership follows the selected upstream target tree, including files both sides added at the same path.
The guard recognizes `it`, `test`, `describe`, and the `effectIt` alias with its Effect variants.

**Two file-local harness deferrals.**

```text
apps/desktop/src/window/DesktopWindow.test.ts
apps/server/src/server.test.ts
```

Both construct the harness in the test module, so a sibling importing an exported helper would register every upstream test too, a larger duplicated seam than the appends it removes.
`fork:scan` reads only these two paths; add no wildcard or domain-wide exemption.

### Diverging from an upstream expectation

The sibling rule is unconditional: a fork case asserting fork behavior always lives in the sibling.
A test merely inconvenient to satisfy is not divergence: fix the fork code or the fork case.

Genuine divergence has two parts, neither editing the upstream assertion: the fork case, and a superseding declaration naming the file and test it supersedes, why the fork changed that behavior, and the commit that did it.
Both live in the `*.fork.test.ts` sibling.
A marker in the upstream test would itself be an in-place upstream edit, so the rule keeps no exception and upstream stays byte-identical.
A declaration must be machine-detectable, never `it.skip`, a comment-out, or any in-place edit, because a bare skip is how an upstream assertion disappears unnoticed.

```ts
// In <name>.fork.test.ts, never in the upstream file:
forkSupersedes({
  upstream: "apps/web/src/preview/Manager.test.ts > broadcasts preview events to every window",
  reason: "project windows scope preview ownership to the owning window",
  commit: "<fork-commit-sha>",
});
```

The declaration is still prose no tool reads: RSI-Software/t3code-hyprws#716 owns the parser.
Write one anyway, because today's declaration is what that parser will find.
When upstream adopts the behavior, the walk deletes the declaration and the contradicting sibling case together; the upstream file needs no repair.

### Extend an upstream export, do not replace it

An upstream-exported schema, list, enum, or switch the fork needs more of stays where upstream declares it.
Deleting and re-declaring it reads as a clean rewrite and silently drops every later upstream edit, because the rebase replays the fork's copy.
Import the upstream declaration from a fork-owned sibling, compose the additions beside it, and export the result under a fork-owned name.

The best fork code looks unsurprising inside upstream T3 Code.
Fork branding belongs in documentation or the desktop boundary, not shared internals.

## Verification standard

Use the smallest proof covering the changed boundary.
Backend behavior changes require focused tests for that behavior.

- **Windows:** create, focus, close, restore
- **Routes:** entry, reload, bad identity, moves
- **Always:** targeted tests, lint, types
- **Material change:** the production build

A delegated worker runs `vp i` in its own worktree first, and every check it reports ran there.
Before declaring visible or stateful behavior complete, do one integrated pass in a real client with permission.

## Decision filter

Prefer the option that makes a project window feel obvious while adding the least permanent machinery.
Reject a shortcut that makes rebases harder, duplicates shared state, or silently breaks another surface.

The fork is healthy when its behavior is distinctive and its diff is boring.
