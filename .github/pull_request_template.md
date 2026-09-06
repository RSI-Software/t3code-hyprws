<!--
Read CONTRIBUTING.md before opening a PR. Review capacity is limited, and meeting
the requirements does not guarantee review or merging. Solve one underlying problem.
The same requirements apply to drafts. Draft status does not defer triage or closure.
Use a conventional commit title in plain language, such as "fix(web): new threads no longer spike CPU".
-->

## Problem

<!-- Explain the problem in a sentence or two. Include expected behavior and
reproduction steps or environment where relevant. -->

## Change

<!-- Explain how this fixes the problem. If it spans components or clients,
explain why those changes are needed for the same fix. Split independent fixes. -->

## Scope and approval

<!-- Link the triaged bug issue or the discussion with explicit maintainer approval
of direction and scope, including the approval comment. For a very small, focused
fix of an obvious bug, explain why it qualifies without a prior issue or discussion.
For focused configuration of an established capability, explain what already exists,
what the option controls, and why its effects stay within that capability. Adding a
setting alone is not a new feature or an approval exemption; broader workflow or
behavior changes still need approval. Scope and verification requirements still apply.
There is no line-count or file-count cutoff. -->

## Verification

<!-- Describe the focused tests or manual checks you ran and the observed results
for the changed behavior. State anything you could not check. "Tests pass" alone
is insufficient; broad repo-wide checks are not required.

For UI changes, include clear before/after screenshots. Include a short recording
when motion, timing, transitions, or interaction details are needed to demonstrate
the change. Upload evidence to GitHub and embed or link it here. Never commit PR-only assets. -->

<!-- If you used an agent, end with the model and harness that did the work. -->

## Fork trailers

<!-- RSI-Software/t3code-hyprws only. Delete this section on an upstream PR.

     This body becomes the squash commit's message, so hyprws CI fails a pull
     request whose body does not END with the trailer block. Keep it last:
     git only reads trailers from the final paragraph.

     Valid Fork-Domain values (copy one exactly; never invent a value):
       browser-bookmarks
       custom-agents
       distribution
       fork-meta
       github-issues
       markdown-editing
       project-windows
       thread-ordering
       upstream-fixes
       workspace-files
       worktrunk-hooks
       zmux-estate

     This list is FORK_DOMAINS in scripts/lib/fork-trailers.ts, and hyprws CI
     refuses a disagreement between the two. The check cannot tell a wrong domain
     from a right one, only a known value from an unknown one, so a plausible
     wrong pick quietly charges another domain's budget ceiling.

     Valid Fork-Tier values: core, qol, bugfix.
     Fork-Upstreamable values: yes, no. Required when Fork-Tier is bugfix.

     Add Fork-Budget: raise <reason> when the squash pushes a domain past a
     ceiling in docs/internals/fork-budget.md. The budget is a ratchet, so most
     fork pull requests raise one; fork:delta --check names the domain and the
     numbers when it is missing.

     Do not copy Base branch or Head branch prompt context into the PR body.
     Do not add prose, metadata, mentions, or headings after the trailers.

     Replace the placeholders below. CI rejects them unedited. -->

Fork-Domain: DOMAIN
Fork-Tier: TIER
