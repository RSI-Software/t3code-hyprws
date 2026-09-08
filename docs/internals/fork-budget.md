# Fork budget

Per-domain ceilings for the fork stack, measured by `vp run fork:delta --inventory`.
`vp run fork:delta --check` fails when a domain's added or deleted lines exceed its ceiling.
Commit counts and shared-file attributions are recorded, not gated: a commit count is not a
cost, and shared attribution moves with every upstream tag even when the fork does not.
Ceilings ratchet down only: lowering one is a normal commit, and raising one requires the
raising commit to carry `Fork-Budget: raise <reason>`. The initial seed carries no trailer —
there is no prior baseline to raise from. A domain without a row has every ceiling at zero,
so a new domain fails the check until a commit adds its row.

| Domain            | Commits | Added | Deleted | Shared |
| ----------------- | ------- | ----- | ------- | ------ |
| browser-bookmarks | 1       | 816   | 29      | 0      |
| custom-agents     | 10      | 8771  | 764     | 17     |
| distribution      | 16      | 1107  | 44      | 0      |
| fork-meta         | 9       | 65569 | 5236    | 3      |
| github-issues     | 9       | 7441  | 1021    | 11     |
| markdown-editing  | 4       | 3900  | 1268    | 2      |
| project-windows   | 46      | 14228 | 2905    | 12     |
| thread-ordering   | 11      | 3043  | 496     | 7      |
| upstream-fixes    | 25      | 4461  | 449     | 22     |
| workspace-files   | 4       | 403   | 48      | 5      |
| worktrunk-hooks   | 6       | 2159  | 906     | 19     |
| zmux-estate       | 23      | 13125 | 1424    | 22     |
