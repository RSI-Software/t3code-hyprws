---
name: fork-uat
description: Review and create one human-owned UAT issue for fork-user changes between the last stable and a Git ref.
---

# Fork UAT

When a human invokes `/fork-uat`, review one ref for acceptance evidence. Never automate acceptance
or move, edit, create, or push a ref. `hyprws` is the default ref; a related issue is context only.

1. Render the review draft:

   ```bash
   vp run fork:uat [--ref <ref>] [--version vX.Y.Z-hyprws] [--since vX.Y.Z-hyprws.N] [--relates-to N]
   ```

   The target defaults to `vX.Y.Z-hyprws` from the ref's upstream base tag. It writes
   `.dump/fork-uat/uat-<version>.md`. When the previous stable has a UAT issue, accepted and unsettled
   conditions are copied into fresh unchecked task drafts with their prior evidence preserved.

2. Read collapsed `## Sources` and `## Excluded`, then finish the task drafts in `## UAT`:
   - group rows by feature under one `###` product-surface heading; sources on the same surface share
     one heading;
   - preserve every applicable carried condition, whether it was previously accepted or unsettled;
     remove one only when the behavior no longer exists, and tell the human;
   - merge exact overlaps between carried conditions and new source behavior, retaining every
     `fork-uat:carried-from` marker on the merged row;
   - for each new source, read its PR body or diff and write one `- [ ]` row per behavior a tester can
     observe in the running app; each row becomes one child issue;
   - phrase each row in 4-9 words: one behavior, product nouns, present tense, no references or code
     identifiers; match the rows in `RSI-Software/t3code-hyprws#245`;
   - expect 1-4 rows for a typical feature; for a “make X direct/simple” fix, cover the before/after
     behavior the user sees;
   - if a source is unclear, keep one row and note the uncertainty to the human instead of guessing;
   - verify no product behavior is missing or duplicated and no upstream or supporting-only behavior
     remains.

   Check the snapshot metadata, then delete all of `## Sources` and `## Excluded`. Keep the
   `fork-uat:task-drafts:v1` marker. Do not re-render.

3. Build and preflight the immutable publication bundle:

   ```bash
   vp run fork:uat --prepare --body <path>
   ```

   This writes `<path>.bundle`: one parent tracker body, one body per acceptance child, and a hashed
   manifest. Show the human the exact parent and child files and titles. Wait for an explicit go;
   uncertainty, empty ledgers/tasks, missing carried conditions, merge commits, missing trailers,
   dirty or moved refs, command failures, or `ghb` refusals are hard stops.

4. After that go, create the tracker and its ordered children:

   ```bash
   vp run fork:uat --create --bundle <path>.bundle --human-approved
   ```

   `--human-approved` records approval of the exact hashed bundle. Creation refuses changed files
   and records one `ghb` receipt per issue. If creation stops, rerun the same command so it resumes
   those receipts; never file a replacement.

5. Hand the parent URL to the human. Each child is the acceptance record: close it only when the
   behavior passes; leave follow-up or polish work open and record findings there. A `Signed off`
   parent comment is recommended when the candidate is accepted in principle, even when non-blocking
   children remain open. The UAT does not automatically gate stable publication. If the app cannot
   launch or basic use fails, tell the human to withhold the explicit release go.
