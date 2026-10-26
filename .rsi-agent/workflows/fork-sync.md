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

This issue is the `hyprws` sync attention issue: a sync stopped on a seam neither rerere nor hook re-apply resolves, or its candidate failed CI.
Its title names the target tag; its body names each manual path and the blocking commit, or each red job.

The `fork-sync` skill owns every step and rule; follow it, and copy nothing from memory.
Its "Job mode" section is this job's procedure, from a clean clone to `HEAD` at the resolution export.

- **Resolve:** by the skill's Conflict section
- **Unsure:** decide per Job mode; never block
- **Verify:** summary ends with what to test
- **Never push `hyprws`:** the driver is its writer
- **Never post:** to `pingdotgg/t3code`
