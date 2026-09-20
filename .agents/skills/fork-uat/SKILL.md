---
name: fork-uat
description: Review and create one human-owned UAT issue for fork-user changes between the last stable and a Git ref.
---

# Fork UAT

A human invokes `/fork-uat`.
Review one ref for acceptance evidence.

- **Default ref:** `hyprws`
- **Related issue:** context only
- **Never** automate acceptance
- **Never** move, edit, create, or push a ref

## 1. Render

```bash
vp run fork:uat [--ref <ref>] [--version vX.Y.Z-hyprws] [--since vX.Y.Z-hyprws.N] [--relates-to N]
```

Omit `--since` for normal work.
The command picks the newest eligible stable tag for the ref's upstream base and carries its UAT.

### Overriding the baseline

- **Use `--since`:** human names a baseline
- **Use `--since`:** rehearsing a migration
- **Confirm:** `Previous stable` `(overridden)`
- **Say:** why the override is intentional
- **Wrong selection:** stop and report
- **Never** silently pin another tag

### Output

- **Target:** `vX.Y.Z-hyprws` from the base tag
- **Path:** `.dump/gh/fork-uat/uat-<version>.md`
- **Carries:** accepted and unsettled conditions
- **Shape:** unchecked drafts, evidence kept
- **Links:** previous UAT, and each task's child
- **Legacy rows:** link the previous UAT

Links are provenance.
They create no containment or release dependency.

## 2. Finish the drafts

Read collapsed `## Sources` and `## Excluded`.
Write `## UAT`.

### Rows

- **Group:** by feature, one `###` surface heading
- **Share:** one heading per surface
- **One row:** one behavior, one child issue
- **Read:** each source's PR body or diff
- **Observable:** a tester sees it in the app
- **Phrase:** 4-9 words, product nouns, present

No references or code identifiers.
Match `RSI-Software/t3code-hyprws#245`.
Expect 1-4 rows per feature.
For a "make X direct" fix, cover the before/after the user sees.

### Carried conditions

- **Preserve:** every applicable condition
- **Both:** previously accepted, and unsettled
- **Drop only:** the behavior is gone
- **Then:** tell the human
- **Merge:** exact overlaps with new behavior
- **Retain:** every `fork-uat:carried-from`

### Before finishing

- **Unclear source:** one row, note the doubt
- **Never** guess
- **Verify:** nothing missing or duplicated
- **Verify:** no upstream or supporting-only rows
- **Check:** the snapshot metadata
- **Delete:** `## Sources` and `## Excluded`

Keep the `fork-uat:task-drafts:v1` marker.
Do not re-render.

## 3. Preflight

```bash
vp run fork:uat --prepare --body <path>
```

`<path>.bundle` holds one parent body, one body per acceptance child, and a hashed manifest.
Show the human the exact files and titles, then wait for an explicit go.

**Hard stops:**

- **Uncertainty** of any kind
- **Empty** ledgers or tasks
- **Missing** carried conditions or trailers
- **Merge commits**
- **Dirty or moved** refs
- **Failures:** command errors, `ghb` refusals

## 4. Create

```bash
vp run fork:uat --create --bundle <path>.bundle --human-approved
```

- **`--human-approved`:** approves that bundle
- **Refuses:** changed files
- **Records:** one `ghb` receipt per issue
- **On a stop:** rerun to resume receipts
- **Never** file a replacement

## 5. Hand over

The parent URL goes to the human.
Each child is the acceptance record.

- **Close a child:** the behavior passes
- **Leave open:** follow-up and polish
- **Record:** findings on that child
- **`Signed off`:** recommended parent comment
- **When:** accepted in principle
- **Even with:** non-blocking children open

The UAT does not gate stable publication.
If the app cannot launch or basic use fails, tell the human to withhold the release go.
