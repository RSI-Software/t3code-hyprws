// The pull-request template is the authority an author actually reads when choosing a
// `Fork-Domain`, because the repository is squash-merge only and the body becomes the squash
// commit message. `fork:delta --check` can only prove that a trailer's value is *a* known domain,
// never that it is the *right* one, so a template that omits a domain silently pushes the change
// onto another domain's ceiling and surfaces later as an unexplained over-budget on a domain
// nobody touched. A hand-maintained copy of the list drifted once already, so it is compared
// against `FORK_DOMAINS` on every check rather than trusted (RSI-Software/t3code-hyprws#713).

import { FORK_DOMAINS } from "./fork-trailers.ts";

/** The template the fork trailer block lives in, and the only file this guard reads. */
export const FORK_PR_TEMPLATE_PATH = ".github/pull_request_template.md";

/** The line the list follows. Its prose may be reworded; the `Fork-Domain values` anchor may not. */
const LIST_HEADING = /Valid\s+Fork-Domain\s+values\b/;

/** One offered value: a bare slug alone on its line, indented under the heading. */
const LIST_ITEM = /^\s+([a-z][a-z\d-]*)\s*$/;

/**
 * The domains the template offers, in the order it offers them, or `undefined` when the template
 * carries no such list at all. An empty array is a heading with nothing under it, which is a
 * different failure from a template that never had the block.
 */
export const parseTemplateForkDomains = (markdown: string): ReadonlyArray<string> | undefined => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => LIST_HEADING.test(line));
  if (start === -1) return undefined;
  const offered: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    const value = LIST_ITEM.exec(line)?.[1];
    if (value === undefined) break;
    offered.push(value);
  }
  return offered;
};

const list = (values: ReadonlyArray<string>): string => values.join(", ");

/**
 * The drift between the template's list and `FORK_DOMAINS`, as one refusal naming both sides, or
 * `undefined` when they agree. Order is part of the comparison: `FORK_DOMAINS` is alphabetical, so
 * a reordered template is a hand edit the next one drifts further from.
 */
export const forkTemplateDriftProblem = (markdown: string | undefined): string | undefined => {
  if (markdown === undefined)
    return `${FORK_PR_TEMPLATE_PATH} is missing; it carries the fork trailer block every squash body needs`;
  const offered = parseTemplateForkDomains(markdown);
  if (offered === undefined)
    return `${FORK_PR_TEMPLATE_PATH} no longer lists the valid Fork-Domain values; restore the list under a "Valid Fork-Domain values" line, in FORK_DOMAINS order: ${list(FORK_DOMAINS)}`;
  const expected = FORK_DOMAINS as ReadonlyArray<string>;
  if (offered.length === expected.length && offered.every((value, at) => value === expected[at]))
    return undefined;
  const missing = expected.filter((value) => !offered.includes(value));
  const unknown = offered.filter((value) => !expected.includes(value));
  const detail =
    missing.length === 0 && unknown.length === 0
      ? "the values are the same but the order is not"
      : [
          missing.length > 0 ? `missing ${list(missing)}` : undefined,
          unknown.length > 0 ? `unknown ${list(unknown)}` : undefined,
        ]
          .filter((part) => part !== undefined)
          .join("; ");
  return `${FORK_PR_TEMPLATE_PATH} offers ${offered.length} of the fork's ${expected.length} domains (${detail}); an author cannot pick a domain the template omits, and a wrong-but-valid Fork-Domain charges another domain's ceiling — replace the list with FORK_DOMAINS in order: ${list(expected)}`;
};
