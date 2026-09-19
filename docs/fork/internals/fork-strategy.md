# Fork strategy

> Target shape of the `hyprws` fork.
> [Fork development](./fork-development.md) owns today's discipline; the [scorecard](./fork-strategy-scorecard.md) tracks the gap.

The fork carries a delta on a fast-moving upstream it never posts to.
Every element ends in permanent carriage or retirement.

## Cost model

Cost is re-expressing the delta on each base, per **seam**: fork intent inside an upstream-owned file.

```text
carry cost ≈ Σ over seams of  churn(file) × width(seam) × opacity(seam)
```

| Factor    | Meaning                                   |
| --------- | ----------------------------------------- |
| `churn`   | How often upstream rewrites the file      |
| `width`   | How much upstream text the seam displaces |
| `opacity` | How hard the intent is to re-derive       |

- **Fork-only additions are near free.**
  A module behind a two-line hook costs two lines.
- **History length is absent.**
  Squashing moves no factor.
- **Only seam reduction compounds.**
  Automation caps price, never count.

## Principles

| #   | Principle                                           | Rule                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The fork is a function.**                         | `hyprws(tag) = apply(delta, tag)`. Identity is `(upstream tag, delta revision)`, never git ancestry. Candidates are disposable; releases are immutable                                                                                                                            |
| 2   | **Every element declares its shape.**               | Addition, seam, or regeneration, each with the replay rule below                                                                                                                                                                                                                  |
| 3   | **Seams are budgeted.**                             | A seam is a liability entry. An undeclared seam fails CI                                                                                                                                                                                                                          |
| 4   | **Granularity is a conflict tool.**                 | A seam commit carries one intent and stays small, because intent re-derives a resolution. Fork-only paths need no curation. A landed stack is never squashed; the domain flatten (RSI-Software/t3code-hyprws#671) was the one spent exception                                     |
| 5   | **Operational history is output.**                  | No record of applying the function enters the replayed delta                                                                                                                                                                                                                      |
| 6   | **Observe fast, adopt slow.**                       | Every tag gets an automatic verdict; a human selects which to adopt                                                                                                                                                                                                               |
| 7   | **Retirement is the success path.**                 | Every domain and seam carries a retirement condition. Carrying a superseded patch is a defect                                                                                                                                                                                     |
| 8   | **Humans decide, agents execute, machines verify.** | The bot lane applies clean fast-forwards and stops on conflict; no AI resolves anything there. An agent drives rehearsal and records under supervision. The human owns adopt-base, contested conflicts, keep/retire, and stable sign-off. Any other human prompt is a tooling bug |

## Element shapes

| Shape            | Contents                   | Replay rule                                                       |
| ---------------- | -------------------------- | ----------------------------------------------------------------- |
| **Addition**     | Fork-only file             | Carry verbatim. A conflict means upstream took the path: escalate |
| **Seam**         | Edit to an upstream file   | 3-way merge, rerere-assisted. Contested resolutions go to a human |
| **Regeneration** | Lockfiles, indexes, stamps | Never merged. Re-run the generator                                |

`pnpm-lock.yaml` carries zero fork intent and never belongs in conflict accounting.

## Domain manifests

One machine-read manifest per domain, replacing today's prose rebase-scan tables.

```yaml
domain: thread-ordering
tier: core
need: Manual sidebar ordering; upstream orders by recency.
owns: # free to grow
  - apps/web/src/sidebarOrder*.ts
seams: # each entry is a budgeted liability
  - file: apps/web/src/components/LegacySidebar.tsx
    anchor: sidebar item render loop
    width: narrow # narrow | interleaved
regenerate: [pnpm-lock.yaml]
retire-when:
  - watch: apps/web/src/components/*Sidebar*
    signal: upstream ships native ordering
wire: none
```

A commit touching an upstream file outside its declared seams fails the scan.
The watch diffs incoming changes against `retire-when`.

## Two planes

- **Product plane:** delta and manifests only
- **Control plane:** engine, scanners, records
- **Divider:** control plane is never replayed

Under the split, fork-meta reduces to the README/AGENTS deltas and the manifests.
Ref shapes are unchanged.

## Sync and provenance

Every upstream tag gets a verdict: clean, textual-block naming seams, or semantic-block naming checks.
That lattice is the radar: what breaks at which seam, on any tag.
Adoption then runs human select, agent rehearse, keep/retire pass, leased promote, human UAT, release.

The trunk is rewritten every sync, so the branch cannot be the delta's identity.
The forge keeps an append-only **delta-log**: one entry per accepted state with base tag, stack range-hash, manifest snapshot, and decisions.
A stable release cites `(upstream tag, delta-rev, result SHA, verification, UAT)` and rebuilds from the first two.

## Steering

Seam pressure publishes per domain: seam count, width, upstream churn, conflicts, resolution time.
Standing decision rule, in order:

1. **Retire:** has upstream superseded it?
2. **Reshape:** can the seam narrow?
3. **Automate:** only after the first two.

## Rejected alternatives

| Alternative                         | Why rejected                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Patch directory** (quilt, Debian) | Loses 3-way merge, rerere, blame, bisect, CI on intermediate states. Its one virtue comes from the delta-log                           |
| **Merge-based tracking**            | Keeps SHAs nobody needs; `log base..hyprws` stops enumerating the delta                                                                |
| **Per-domain branches**             | One rebase per domain per sync                                                                                                         |
| **jj / stacked diffs as truth**     | Change-IDs fit the model; maturity does not yet. Revisit                                                                               |
| **Vendored upstream**               | Inverts authority, maximizes entanglement                                                                                              |
| **Plugin architecture**             | No upstream plugin API, and the no-post rule forbids adding one. Fat `owns:` with narrow `seams:` is that architecture without the API |
| **Full divergence**                 | Wrong while the fork wants upstream's future. Reconsider if porting overtakes adoption                                                 |

## Doctrine

> Buy features with fork-only files; pay only at declared seams; watch every seam for the day upstream lets you delete it.
