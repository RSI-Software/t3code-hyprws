---
name: fork-uat
description: Review and create one human-owned UAT issue for fork-user changes between the last stable and a Git ref.
---

# Fork UAT

When a human invokes `/fork-uat`, review one ref for acceptance evidence. Never automate this flow or
move, edit, create, or push a ref. `hyprws` is the default ref; a related issue is context only.

1. Render and preflight the draft:

   ```bash
   vp run fork:uat [--ref <ref>] [--version vX.Y.Z-hyprws] [--since vX.Y.Z-hyprws.N] [--relates-to N]
   ```

   The target defaults to `vX.Y.Z-hyprws` from the ref's upstream base tag. It writes
   `.dump/fork-uat/uat-<version>.md` and preflights the title `UAT <version>`.

2. Read collapsed `## Sources` and `## Excluded`, then write the testing guide in `## UAT`:
   - group rows by feature under one `###` product-surface heading; sources on the same surface share
     one heading;
   - for each source, read its PR body or diff and write one `- [ ]` row per behavior a tester can
     observe in the running app;
   - phrase each row in 4-9 words: one behavior, product nouns, present tense, no references or code
     identifiers; match the rows in `RSI-Software/t3code-hyprws#245`;
   - expect 1-4 rows for a typical feature; for a “make X direct/simple” fix, cover the before/after
     behavior the user sees;
   - if a source is unclear, keep one row and note the uncertainty to the human instead of guessing;
   - verify no product behavior is missing or duplicated and no upstream or supporting-only behavior
     remains.

   Check the snapshot metadata, then delete all of `## Sources` and `## Excluded`. Do not re-render.

3. Show the human the final draft path and exact UAT rows. Wait for an explicit go; uncertainty,
   empty ledgers/rows, merge commits, missing trailers, dirty refs, command failures, or `ghb`
   refusals are hard stops.
4. After that go, post the reviewed file as-is:

   ```bash
   vp run fork:uat --create --body <path>
   ```

   Creation refuses a remaining `## Excluded`. On refused or ambiguous creation, follow only the
   printed resume instruction and never file a replacement. Hand the URL to the human to tick rows,
   comment findings, and close with `Signed off` or `Blocked: <reason>`.
