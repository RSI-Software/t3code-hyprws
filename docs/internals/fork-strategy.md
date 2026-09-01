# Fork strategy

> The target shape of the `hyprws` fork.
> [Fork development](./fork-development.md) owns today's working discipline; this document records
> where the model is heading and why. The
> [scorecard](./fork-strategy-scorecard.md) tracks the gap between the two.

The fork carries a delta on top of a fast-moving upstream it never posts to. Every fork change is
carried until upstream independently supersedes it, so the strategy assumes exactly two end states
for any change: permanent carriage or retirement.

## Cost model

The recurring cost of the fork is re-expressing the delta on each new upstream base. That cost
decomposes per **seam** — a hunk of fork intent inside an upstream-owned file:

```text
carry cost ≈ Σ over seams of  churn(file) × width(seam) × opacity(seam)
```

- `churn` — how often upstream rewrites that file.
- `width` — how much upstream text the seam displaces or interleaves with.
- `opacity` — how hard the seam's intent is to re-derive once the surrounding code moves.

Three consequences:

1. Fork-only additions are nearly free. A large fork-only module behind a two-line registration
   hook costs two lines.
2. History length is not in the formula. Squashing the stack changes no churn, no width, no
   opacity. Commit count is not a cost.
3. Only seam reduction compounds. Automation, rerere, and rehearsal tooling reduce the price per
   conflict; only fewer and narrower seams reduce the number of collisions.

## Principles

1. **The fork is a function.** `hyprws(tag) = apply(delta, tag)`. Identity is the pair
   `(upstream tag, delta revision)`, never git ancestry. Candidates are disposable evaluations;
   releases are immutable results.
2. **Every delta element declares its shape** — addition, seam, or regeneration — and each shape
   has its own replay rule (below).
3. **Seams are budgeted and inventoried.** A seam is a liability entry. An undeclared seam fails
   CI; seam growth is visible per domain.
4. **Commit granularity is a conflict-resolution tool.** A commit that touches a seam carries one
   intent and stays small forever, because intent is what re-derives a resolution. Inside
   fork-only paths, granularity is economically irrelevant; spend no effort curating it.
5. **Operational history is output, never input.** No record of applying the function — sync
   records, rehearsal logs, tooling iteration — enters the delta the function replays.
6. **Observe at upstream speed, adopt at human speed.** Every upstream tag gets an automatic
   compatibility verdict; a human selects which tag to adopt.
7. **Retirement is the success path.** Every domain and seam carries a retirement condition,
   machine-watched where possible. Carrying a superseded patch is a defect.
8. **Humans decide semantics; agents execute; machines verify the rest.** Three actors, three
   lanes. The bot lane applies clean fast-forwards and stops on conflict — no AI resolves anything
   there. An agent drives every rehearsal, conflict resolution, and record in the unblock lane,
   under human supervision. The human owns four decision points: adopt-base selection, contested
   conflict resolution, keep/retire calls, and stable sign-off via guided UAT. Any other step that
   asks for a human is a tooling bug; any lane where a human resolves conflicts by hand is one too.

## Element shapes and replay rules

| Shape            | Contents                                     | Replay rule                                                                                                                          |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Addition**     | Fork-only file                               | Carry verbatim. A conflict means upstream created the same path; escalate, don't merge.                                              |
| **Seam**         | Edit to an upstream file                     | 3-way merge, rerere-assisted. Commit intent plus the manifest anchor are the resolution inputs; contested resolutions go to a human. |
| **Regeneration** | Lockfiles, generated indexes, version stamps | Never merged. Re-run the generator on the new base.                                                                                  |

The regeneration class removes an entire category of guaranteed textual conflicts — `pnpm-lock.yaml`
carries zero fork intent and should never appear in conflict accounting.

## Domain manifests

Each domain is defined by one machine-read manifest. Checks enforce it; prose serves it.

```yaml
domain: thread-ordering
tier: core
need: Manual sidebar ordering and groups; upstream orders by recency only.
owns: # additions — free to grow
  - apps/web/src/sidebarOrder*.ts
seams: # each entry is a budgeted liability
  - file: apps/web/src/components/LegacySidebar.tsx
    anchor: sidebar item render loop
    width: narrow # narrow | interleaved
    why: mounts the ordering controls
regenerate:
  - pnpm-lock.yaml
retire-when:
  - watch: apps/web/src/components/*Sidebar*
    signal: upstream ships native manual ordering or grouping
wire: none
```

The manifest replaces today's prose rebase-scan tables as the source of truth. A commit touching an
upstream file outside its domain's declared seams fails the scan; the upstream watch diffs incoming
changes against `retire-when` and files retirement candidates automatically.

## Two planes

The **product plane** (`t3code-hyprws`) holds the delta and the manifests — nothing else. The
**control plane** (a separate forge repository) holds the sync engine, scanners, pressure reports,
release automation, and all operational records. The dividing property: the control plane is
everything that is never replayed onto a new base. Under this split the fork-meta domain reduces to
the README/AGENTS deltas and the manifests.

Refs keep their current shape: `main` as an exact upstream mirror, `hyprws` as the accepted output,
`hyprws-next` and `hyprws-previous` for candidate and recovery, leased promotion, create-only
`release/*` snapshots.

## Sync and provenance

```text
every upstream tag T:   candidate(T) = apply(delta, T)
                        verdict(T) ∈ { clean | textual-block(seams) | semantic-block(checks) }
adoption:               human selects T* → agent rehearses, human watching → keep/retire pass → leased promote → human UAT → release
```

The per-tag verdict lattice is the fork's radar: a standing answer to "if we moved to any tag right
now, what breaks, at which seam?"

Because the trunk is rewritten on every sync, the branch cannot be the delta's identity. The forge
keeps an append-only **delta-log**: one entry per accepted state, recording base tag, stack
range-hash, manifest snapshot, and retire/add decisions. A stable release cites
`(upstream tag, delta-rev, result SHA, verification, UAT)` and is reconstructable from the first
two.

## Steering

The forge publishes seam pressure per domain: seam count, total width, upstream churn on seamed
files, conflicts and resolution time over recent syncs. The standing decision rule, in order:

1. **Retire** — has upstream superseded it?
2. **Reshape** — can the seam narrow? Move logic into `owns:` paths; leave a one-line hook.
3. **Automate** — only after the first two, because automation caps the price per conflict without
   reducing collisions.

## Rejected alternatives

- **Patch directory (quilt/Debian/OpenWrt).** Loses 3-way merge, rerere, blame, bisect, and CI on
  intermediate states. Its one virtue — delta as reviewable artifact — comes from the delta-log
  instead.
- **Merge-based tracking.** Preserves fork SHAs nobody needs and makes the delta unenumerable;
  `log base..hyprws` stops answering "what do we change?".
- **Per-domain branches.** One rebase per domain per sync.
- **jj / stacked-diff tooling as source of truth.** Stable change-IDs across rebases fit this model
  well; ecosystem maturity doesn't yet. Revisit — nothing above depends on git ancestry.
- **Vendored upstream.** Inverts authority and maximizes exactly the entanglement the cost model
  minimizes.
- **Plugin architecture.** Upstream has no plugin API and the no-post rule forbids adding one. The
  manifest discipline — fat `owns:`, narrow anchored `seams:` — is the plugin architecture without
  the API.
- **Full divergence.** Wrong while the fork still wants upstream's future. Reconsider if most
  releases need extensive semantic porting, shared ownership becomes the norm, or cherry-picking
  overtakes wholesale adoption.

## Doctrine

> Buy features with fork-only files; pay for them only at declared seams; watch every seam for the
> day upstream lets you delete it.
