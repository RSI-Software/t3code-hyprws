---
name: fork-sync
description: Unblock an RSI-Software/t3code-hyprws upstream rebase with a reported rehearsal and leased apply, or cut a stable fork release from a bot-owned snapshot.
---

# Fork sync

Choose exactly one entry point: **unblock** or **cut stable**. Never post to `pingdotgg/t3code`,
merge upstream into `hyprws`, or move a bot-owned ref by hand. The
[fork-sync runbook](../../../docs/operations/fork-sync.md) owns the bot model and recovery.

## Entry point: unblock

Each command consumes the prior external report. Never alter its state, continue a rebase directly,
or bypass a refusal or `fork:sync-gate`.

1. List the current block and selectable targets:

   ```bash
   vp run fork:sync unblock-list
   ```

   **Stop.** Show the blocker and offered tags. Continue only after the human selects one; recency
   is not permission to infer it.

2. Bind that selection and render orientation:

   ```bash
   vp run fork:sync unblock-orient --report <report> --target <human-selected-tag>
   ```

   **Stop.** Show target/source/shared-base SHAs, conflicts, automerged overlap, retire candidates,
   and watch verdicts. Continue only after the human confirms the exact target.

3. Start or resume the reported rehearsal:

   ```bash
   vp run fork:sync unblock-rehearse --report <report>
   ```

   At a stop, preserve upstream intent and complete non-generated rows with `mechanical`,
   `seam-moved`, `retire-candidate`, or `human`; judgement stays human-owned. The verb regenerates
   `pnpm-lock.yaml` and owns comment-safe continuation. Rerun it until replay complete.

   **Stop.** Present every conflict row and any unresolved human choice. Continue only when every
   row is complete; a clean replay still owes the report's count and byte-identical-message proof.

4. Check the completed replay:

   ```bash
   vp run fork:sync unblock-check --report <report>
   ```

   The verb assigns importer lock drift to a manifest-owning commit, discards snapshots-only drift,
   installs at the final replay head, then runs scan, ledger, derived typechecks, and adjacent tests.
   Fix a refused silent seam in its owning fork commit and repeat the rehearsal/check; never weaken a
   check or substitute a repo-wide command.

   **Stop.** Present the emitted Gate 4 decision surface, silent seams, and grounding evidence.
   Continue only when the human gives every keep/retire/partial decision by exact subject, confirms
   grounding, records `Human sanity: <login> YYYY-MM-DD`, and gives an explicit go. Put those values
   in the rendered record; the agent must not infer them.

5. Apply the reviewed record:

   ```bash
   vp run fork:sync unblock-apply --report <report> --record <record>
   ```

   This calls `fork:sync-gate`, posts the record, and uses only its expected-old lease. Rejection
   voids the report: retain its external files and restart at step 1. Never commit them.

## Entry point: cut stable

Use this only for an open `release` issue created from a bot-owned
`release/vX.Y.Z-hyprws` snapshot. Never cut a stable from `hyprws`, `hyprws-next`, a rehearsal branch,
or a local commit. Never move the snapshot branch or replace an existing tag.

### Stable gate 1 — Identify

```bash
gh issue list --state open --label release \
  -R RSI-Software/t3code-hyprws
```

Read the selected issue and confirm its exact title is `Stable candidate vX.Y.Z-hyprws`, its body
names the matching snapshot, and the branch exists on `origin`. If several candidates are open, stop
for the human to select one; recency is not permission to choose.

### Stable gate 2 — Verify

Follow the runbook's exact [cut a stable release](../../../docs/operations/fork-sync.md#cut-a-stable-release)
preparation and verification blocks through `vp run test`. They derive the snapshot ref and next
release number from the selected issue, create a disposable Worktrunk lane at the exact remote
commit, and run the same preflight checks as the stable release workflow.

Before tagging, run `vp run fork:uat --ref origin/release/vX.Y.Z-hyprws --relates-to N` under the
[`fork-uat`](../fork-uat/SKILL.md) judgment boundary on the exact ref you intend to tag, then read the
created UAT issue. The candidate issue is optional relationship context, never the UAT input. The
checked rows and latest human `Signed off` or `Blocked: <reason>` comment are sign-off evidence; they
inform the release judgment and never gate it automatically.

**Stop.** Show the human the issue, snapshot branch and SHA, derived new tag, prior matching tags,
and all check results. Continue only when the worktree is clean, every check passes,
the remote snapshot still resolves to the checked SHA, the tag does not already exist locally or
remotely, and the human records the exact candidate and an explicit go. Missing sign-off is a hard
stop.

### Stable gate 3 — Publish

After the human signs off, the agent creates an annotated `vX.Y.Z-hyprws.<n>` tag at the verified
snapshot SHA, pushes it create-only, watches the exact `hyprws-release.yml` run, verifies the
`.AppImage` and `latest-linux.yml`, and closes the candidate issue with the tag, snapshot SHA, and
workflow URL.

A failed push or existing tag is a stop, not permission to increment again without re-running the
stable gates and obtaining fresh sign-off. A failed workflow leaves the candidate issue open. Bot
run summaries record automatic rewrites; human rehearsal records are comments on their blocked
issues. An ordinary stable cut from a bot snapshot creates neither kind of rehearsal record.
