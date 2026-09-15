// The fork gates report progress on stderr, and a test suite is not an operator terminal.
// `FORK_QUIET=1` is the same gate the gates themselves read, so a fork-owned test file that
// imports this runs silent. A test that asserts on progress clears the variable for its own scope.
//
// This is an import rather than a Vitest `setupFiles` entry on purpose: `vite.config.ts` is a pure
// upstream file, and a fork line there is a woven seam the rebase has to carry forever
// (RSI-Software/t3code-hyprws#665). Every file that needs the silence is fork-owned, so the import
// costs nothing upstream.
process.env.FORK_QUIET ??= "1";
