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

### Stop shape

At every stop in steps 1–4, first reproduce the emitted decision surface verbatim and unchanged. Then
write one triage line per decision in exactly one of these forms:

- `clear — <recommendation>: <one-line reason>` for a mechanical or unambiguous choice;
- `judgement — <recommendation>: <reading A> vs <reading B>; <why the recommendation>` for a real
  choice, with enough context for a reader who has not seen the diff.

Then ask for the human's exact word for every decision and stop. A recommendation never becomes a
record entry on its own. In steps 3 and 4, test every `retire-candidate` by asking: “does the upstream
hunk implement the fork behaviour?” If the row does not make the answer obvious, show both hunks—the
`git diff` of the fork commit's hunk and the upstream hunk—before recommending. Treat `mechanical`
and `seam-moved` rows as `clear` by default unless the resolution dropped or moved fork behaviour.

0. Pause the bot for the whole ladder or walk series:

   ```bash
   gh variable set HYPRWS_AUTO_REBASE --body candidate --repo RSI-Software/t3code-hyprws
   ```

   After each apply, run
   `gh workflow run hyprws-upstream-sync.yml --repo RSI-Software/t3code-hyprws` once. Confirm the
   blocked issue closes with `Resolved by hyprws <sha>` and the next block opens, or none remains.
   Restore `on` only when the ladder or walk series ends.

1. List the current block and selectable targets:

   ```bash
   vp run fork:sync unblock-list
   ```

   **Stop.** Apply the stop shape to the blocker and offered tags. Recommend the target named by an
   open tracker sub-issue titled `unblock walk lands <tag>`; if none is open, recommend the oldest
   offered tag that contains the block. Name which rule fired, and require the human's exact tag;
   recency is not permission to record a selection.

2. Bind that selection and render orientation:

   ```bash
   vp run fork:sync unblock-orient --report <report> --target <human-selected-tag>
   ```

   **Stop.** Apply the stop shape to the target/source/shared-base SHAs, conflicts, automerged
   overlap, retire candidates, and watch verdicts. Continue only after the human confirms the exact
   target.

3. Start or resume the reported rehearsal:

   ```bash
   vp run fork:sync unblock-rehearse --report <report>
   ```

   At a stop, preserve upstream intent and recommend `mechanical`, `seam-moved`, `retire-candidate`,
   or `human` for each non-generated row; only the human's exact classification may be recorded. The
   verb regenerates `pnpm-lock.yaml` and owns comment-safe continuation. Rerun it until replay
   complete.

   **Stop.** Apply the stop shape and the retire-candidate test to every conflict row and unresolved
   human choice. Continue only after the human supplies the exact classification for every row; a
   clean replay still owes the report's count and byte-identical-message proof.

4. Check the completed replay:

   ```bash
   vp run fork:sync unblock-check --report <report>
   ```

   The verb assigns importer lock drift to a manifest-owning commit, discards snapshots-only drift,
   installs at the final replay head, and runs scan and ledger locally. It pushes the disposable lane
   and polls every 30 seconds for the CI verdict on the pushed lane head, with a 45-minute ceiling.
   A timeout fails the gate. Never substitute repo-wide local checks.

   **Stop.** Apply the stop shape and the retire-candidate test to the emitted Gate 4 decision
   surface, silent seams, and grounding evidence. On a failed gate, present the failing job names and
   last 40 failed-log lines verbatim before any interpretation. Continue only when the human gives
   every keep/retire/partial decision by exact subject and gives an explicit go; when the surface
   names a grounding claim, get that confirmation too. Put only those supplied decisions in the
   rendered record; never record a recommendation as the human's decision.

5. Apply the reviewed record:

   ```bash
   vp run fork:sync unblock-apply --report <report> --record <record>
   ```

   This refuses a rehearsal lane moved since the CI verdict, calls `fork:sync-gate`, posts the
   record, uses only its expected-old lease, and deletes the remote lane after apply. Rejection voids
   the report: retain its external files and restart at step 1. Never commit them.

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
