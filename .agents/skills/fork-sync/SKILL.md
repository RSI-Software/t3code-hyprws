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

Use this only for an open stable-candidate issue created from a bot-owned snapshot. The report paths
are external operator state; never edit them, move a bot-owned ref, replace a tag, or infer a
candidate.

1. List candidates with `vp run fork:sync stable-list`.

   **Stop.** Show every reported issue, candidate, and snapshot branch. Continue only after the human
   selects one exact issue number; recency is not permission to choose.

2. Bind the selection with
   `vp run fork:sync stable-prepare --report <report> --issue <human-selected-issue>`.

   Review the emitted UAT draft under the [`fork-uat`](../fork-uat/SKILL.md) judgement boundary:
   write observable rows, remove reviewer-only sections, show the exact draft to the human, and
   create it only after their explicit UAT-draft go. Hand the created issue to the human to run and
   record `Signed off` or `Blocked: <reason>`; those facts inform judgement and never become an
   automatic pass/fail rule.

   **Stop.** Present the selected issue, snapshot branch and SHA, derived tag, prior matching tags,
   every preparation result, clean/ref checks, and UAT evidence. Continue only when the human names
   the exact candidate and gives an explicit release go. Missing sign-off, ambiguity, or a blocked
   UAT is a hard stop; the agent must not infer acceptance.

3. After that go, publish with
   `vp run fork:sync stable-publish --report <report> --go <exact-candidate>`.

   **Stop on every refusal.** A changed issue or snapshot, moved or dirty lane, existing tag, failed
   push/workflow, or missing asset requires a fresh `stable-list` report and fresh human sign-off;
   never increment, replace, or repair the release by hand.
