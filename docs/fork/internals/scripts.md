# Scripts

> For maintainers. Using T3 Code? See [docs/user](../user/).

`package.json` **lists every script**; [Development](../../operations/development.md) owns **setup, dev state, ports, and desktop builds**.
This page holds what a fork script name cannot carry.

## Upstream reference guard

`vp run fork:upstream-refs <file>...` **scans body files** for a live upstream reference; anything left live, or **an unreadable path, exits 1**.
It masks **fenced blocks, code spans, and HTML comments**; a citation in any other shape GitHub renders as code is **still reported**.
A **bare `#4379` is a finding**: GitHub resolves it against `pingdotgg/t3code`, and the guard cannot tell offline which numbers the fork holds.
An upstream URL **naming no item** is not a finding.
[Upstream citations](./fork-development.md#upstream-citations) own the **wrapping forms**.

**The pre-publication run is the gate**: the backlink posts the moment the item is created, and nothing withdraws it.
`hyprws-body.yml` re-runs it on pull-request bodies as a **backstop that reports** a fired backlink.

The guard **does not cover**:

- **Issue bodies and comments** get no CI backstop
- **Titles** are never scanned
- **Pull requests** not based on `hyprws` or `release/**`

It **over-reports**, erring toward a finding:

- A **bare fork number**
- **Link text**, though GitHub links only the URL
- **Indented code** and **quoted fences**
