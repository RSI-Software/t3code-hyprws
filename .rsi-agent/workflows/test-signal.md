---
# fork-mirror: .macroscope/check-run-agents/test-signal.md@67c442a17e6e5d6c9f768714820cecb5f15d4f9b
name: Test Signal
on: [pr-change, pr-label, check-rerun]
paths:
  include:
    - "**/*.test.*"
  exclude:
    - ".repos/**"
context: [docs/internals/15_testing.md]
needs: [checkout]
---

# Test signal review

Review only the tests this pull request adds or grows, in changed `*.test.*` files outside `.repos/`. Tests it moves, renames, or deletes are not findings. The rules are in `docs/internals/15_testing.md` under `## What to test`; read that section first and hold new tests to it.

Name the test for each finding and give one fix. Ask only for fewer or smaller tests, never for more coverage.
