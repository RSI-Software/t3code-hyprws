// @effect-diagnostics nodeBuiltinImport:off - The shipped template is read synchronously.

import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  FORK_PR_TEMPLATE_PATH,
  forkTemplateDriftProblem,
  parseTemplateForkDomains,
} from "./fork-pr-template.ts";
import { FORK_DOMAINS } from "./fork-trailers.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

const template = (domains: ReadonlyArray<string>): string =>
  [
    "## Fork trailers",
    "",
    "<!-- RSI-Software/t3code-hyprws only.",
    "",
    "     Valid Fork-Domain values (copy one exactly; never invent a value):",
    ...domains.map((domain) => `       ${domain}`),
    "",
    "     Valid Fork-Tier values: core, qol, bugfix. -->",
    "",
    "Fork-Domain: DOMAIN",
  ].join("\n");

it("reads the offered values in the order the template offers them", () => {
  assert.deepStrictEqual(parseTemplateForkDomains(template(["zmux-estate", "fork-meta"])), [
    "zmux-estate",
    "fork-meta",
  ]);
  assert.strictEqual(
    parseTemplateForkDomains("## Fork trailers\n\nFork-Domain: DOMAIN\n"),
    undefined,
  );
});

it("names the domains an author cannot pick", () => {
  const problem = forkTemplateDriftProblem(
    template([
      "project-windows",
      "custom-agents",
      "markdown-editing",
      "fork-meta",
      "distribution",
      "upstream-fixes",
      "zmux-estate",
    ]),
  );
  assert.isDefined(problem);
  // The five omitted on the day RSI-Software/t3code-hyprws#713 was filed.
  for (const missing of [
    "browser-bookmarks",
    "github-issues",
    "thread-ordering",
    "workspace-files",
    "worktrunk-hooks",
  ])
    assert.include(problem ?? "", missing);
  // Counted from FORK_DOMAINS, so opening a domain does not break this case.
  assert.include(problem ?? "", `offers 7 of the fork's ${FORK_DOMAINS.length} domains`);
});

it("refuses an invented value and a reordered list", () => {
  const invented = forkTemplateDriftProblem(template([...FORK_DOMAINS, "fork-metaa"]));
  assert.include(invented ?? "", "unknown fork-metaa");

  const reordered = forkTemplateDriftProblem(template([...FORK_DOMAINS].toReversed()));
  assert.include(reordered ?? "", "the values are the same but the order is not");
});

it("refuses a template that lost the block, or the file", () => {
  assert.include(
    forkTemplateDriftProblem("## What Changed\n") ?? "",
    "no longer lists the valid Fork-Domain values",
  );
  assert.include(forkTemplateDriftProblem(undefined) ?? "", "is missing");
});

it("passes the template the fork actually ships", () => {
  const markdown = NodeFS.readFileSync(NodePath.join(repoRoot, FORK_PR_TEMPLATE_PATH), "utf8");
  assert.strictEqual(forkTemplateDriftProblem(markdown), undefined);
  // The template is also the only place an author learns a raise is needed at all.
  assert.include(markdown, "Fork-Budget: raise <reason>");
});
