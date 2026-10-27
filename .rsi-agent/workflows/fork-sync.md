---
name: Fork sync
on: [issue-label]
context: [.agents/skills/fork-sync/SKILL.md]
needs: [checkout, push]
outputs: { branch: sync/resolution }
trust: { bots: ["github-actions[bot]"] }
timeout: 45
---

# Fork sync resolution

This issue is the `hyprws` sync attention issue: a sync stopped on a seam the driver cannot resolve, a carried trunk commit conflicted, or its candidate failed CI.
Its title names the target tag; its body names each manual path and blocking commit, the commits left, or each red job.

The `fork-sync` skill owns every step and rule; follow its procedure and its Job section, and copy nothing from memory.

- **Hand off:** `HEAD` at the marker; `committed`
- **Unsure:** decide per the skill; never block
- **Verify:** summary ends with what to test
- **Partial:** fine; hand off before the budget
- **Never push `hyprws`:** the land run writes it
- **Never post:** to `pingdotgg/t3code`
