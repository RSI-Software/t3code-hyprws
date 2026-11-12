---
# fork-mirror: .macroscope/check-run-agents/test-signal.md@bc647ed53595888efacdd8ca435967d48888a952
name: Test Signal
on: [pr-change, pr-label, check-rerun]
paths:
  include:
    - "**/*.test.*"
  exclude:
    - ".repos/**"
context: [docs/internals/testing.md]
needs: [checkout]
---

# Test signal review

Review only the tests this pull request adds or grows, in changed `*.test.*` files outside `.repos/`. Tests it moves, renames, or deletes are not findings. The rules are in `docs/internals/testing.md` under `## What to test`; read that section first and hold new tests to it.

Name the test for each finding and give one fix. Ask only for fewer or smaller tests, never for more coverage.
