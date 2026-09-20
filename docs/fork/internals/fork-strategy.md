# Fork strategy

> Target shape of the `hyprws` fork.
> [Fork development](./fork-development.md) owns today's discipline; the [scorecard](./fork-strategy-scorecard.md) tracks the gap.

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
- **Squashing moves no cost factor.**
- **Only seam reduction compounds.**

## Principles

| #   | Principle                                           | Rule                                                                                                                                           |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The fork is a function.**                         | `hyprws(tag) = apply(delta, tag)`. Identity is `(upstream tag, delta revision)`, never git ancestry                                            |
| 2   | **Every element declares its shape.**               | Addition, seam, or regeneration, each with the replay rule below                                                                               |
| 3   | **Seams are budgeted.**                             | An undeclared seam fails CI                                                                                                                    |
| 4   | **Granularity is a conflict tool.**                 | One intent per seam commit; intent re-derives a resolution. Never squash a landed stack (RSI-Software/t3code-hyprws#671 was the one exception) |
| 5   | **Operational history is output.**                  | No record of applying the function enters the replayed delta                                                                                   |
| 6   | **Observe fast, adopt slow.**                       | Every tag gets an automatic verdict; a human selects which to adopt                                                                            |
| 7   | **Retirement is the success path.**                 | Carrying a superseded patch is a defect                                                                                                        |
| 8   | **Humans decide, agents execute, machines verify.** | Human owns adopt-base, contested conflicts, keep/retire, sign-off. Any other human prompt is a tooling bug                                     |

## Element shapes

| Shape            | Contents                   | Replay rule                                                       |
| ---------------- | -------------------------- | ----------------------------------------------------------------- |
| **Addition**     | Fork-only file             | Carry verbatim. A conflict means upstream took the path: escalate |
| **Seam**         | Edit to an upstream file   | 3-way merge, rerere-assisted. Contested resolutions go to a human |
| **Regeneration** | Lockfiles, indexes, stamps | Never merged. Re-run the generator                                |

`pnpm-lock.yaml` carries zero fork intent and never enters conflict accounting.

## Domain manifests

One machine-read manifest per domain, replacing prose rebase-scan tables.

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

## Two planes

- **Product plane:** delta and manifests only
- **Control plane:** engine, scanners, records
- **Divider:** control plane is never replayed

fork-meta then reduces to the README and AGENTS deltas plus manifests.

## Sync and provenance

| Item             | Contents                                                 |
| ---------------- | -------------------------------------------------------- |
| **Tag verdict**  | clean, textual block, or semantic block                  |
| **Adoption**     | select, rehearse, keep/retire, promote, UAT, release     |
| **Delta-log**    | append-only, one entry per accepted state                |
| **Entry**        | base tag, stack range-hash, manifest snapshot, decisions |
| **Release cite** | upstream tag, delta-rev, result SHA, verification, UAT   |

## Steering

Seam pressure publishes per domain: count, width, churn, conflicts, resolution time.
Standing decision rule, in order:

1. **Retire:** has upstream superseded it?
2. **Reshape:** can the seam narrow?
3. **Automate:** only after the first two.

## Rejected alternatives

| Alternative                         | Why rejected                                         |
| ----------------------------------- | ---------------------------------------------------- |
| **Patch directory** (quilt, Debian) | Loses 3-way merge, rerere, blame, bisect, CI         |
| **Merge-based tracking**            | `log base..hyprws` stops enumerating the delta       |
| **Per-domain branches**             | One rebase per domain per sync                       |
| **jj / stacked diffs as truth**     | Change-IDs fit; maturity does not yet                |
| **Vendored upstream**               | Inverts authority, maximizes entanglement            |
| **Plugin architecture**             | No upstream API; the no-post rule forbids adding one |
| **Full divergence**                 | Wrong while the fork wants upstream's future         |

## Doctrine

> Buy features with fork-only files; pay only at declared seams; watch every seam for the day upstream lets you delete it.
