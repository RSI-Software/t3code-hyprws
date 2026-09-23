// Upstream's installer test pins pingdotgg/t3code and a plain stable tag, which the fork
// installer refuses by design; install.fork.test.ts covers the fork installer instead.
export const FORK_TEST_EXCLUDE = ["**/install.test.ts"];
