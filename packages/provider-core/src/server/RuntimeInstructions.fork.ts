// Fork-owned runtime instruction for thread ↔ GitHub issue links
// (RSI-Software/t3code-hyprws#1433). `RuntimeInstructions.ts` interpolates it
// on its own line beside the pull request instruction through the marked
// `github-issues/runtime-instructions` hook.

const ISSUE_LINKING =
  "When the t3-code MCP server exposes link_issue, call it with the full issue URL as soon as you take up a GitHub issue for this thread, including an issue you were handed or one your change resolves. Linking an already-linked issue is safe; call list_thread_issues to check. Do not link issues mentioned only as background. If a linking call fails, report that failure instead of claiming the issue is linked.";

// Mirrors `resolveGitHubReferenceHref` in apps/web/src/components/chat/githubReferences.fork.ts.
const GITHUB_REFERENCES =
  "Chat turns every #N you write into a link to this project's repository, or to this thread's linked PR or issue with that number, even right after you name another repository. So for any other repository, qualify every mention, repeats included: write infra#12 (or owner/repo#12 under another owner), never #12 or infra #12.";

export const THREAD_ISSUE_LINKING_INSTRUCTION_FORK = `${ISSUE_LINKING}\n${GITHUB_REFERENCES}`;

/** Thread ↔ artifact links (fork domain `thread-artifacts`), on the line after the issue one. */
export const THREAD_ARTIFACT_LINKING_INSTRUCTION_FORK =
  "When the t3-code MCP server exposes link_artifact and you write a document the user should keep seeing, such as an HTML visualization or report, a plan, a tracker, or notes, call link_artifact once after creating it. Later edits show automatically, so do not relink it or paste its contents into chat.";
