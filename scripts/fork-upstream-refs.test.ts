import { assert, it } from "@effect/vitest";

import {
  findUpstreamReferences,
  FORK_REPO,
  maskMarkdownCode,
  renderReferences,
  UPSTREAM_REPO,
} from "./fork-upstream-refs.ts";

const lines = (...input: ReadonlyArray<string>) => input.join("\n");

const texts = (body: string) => findUpstreamReferences(body).map((reference) => reference.text);

it("refuses a live cross-repo reference and points at it", () => {
  const references = findUpstreamReferences(
    lines("Upstream context.", "", "The regression landed in pingdotgg/t3code#4379 last week."),
  );
  assert.deepStrictEqual(references, [
    { kind: "issue", text: "pingdotgg/t3code#4379", line: 3, column: 26 },
  ]);
  assert.strictEqual(
    renderReferences(references),
    "3:26 pingdotgg/t3code#4379 (cross-repo issue reference)\n",
  );
});

it("accepts a reference inside a code span", () => {
  assert.deepStrictEqual(texts("The regression landed in `pingdotgg/t3code#4379` last week."), []);
});

it("accepts a code span written with a doubled backtick run", () => {
  assert.deepStrictEqual(texts("Cite it as `` `pingdotgg/t3code#4379` `` in the body."), []);
});

it("accepts a pasted survey inside one fenced block", () => {
  assert.deepStrictEqual(
    texts(
      lines(
        "The upstream survey:",
        "",
        "```text",
        "pingdotgg/t3code#4379 files explorer tab",
        "pingdotgg/t3code#4402 symlinked workspaces",
        "```",
        "",
        "Both are already carried here.",
      ),
    ),
    [],
  );
});

it("accepts a fence indented under a list item", () => {
  assert.deepStrictEqual(
    texts(lines("- The survey rows:", "", "  ```text", "  pingdotgg/t3code#4379", "  ```")),
    [],
  );
});

it("accepts a backtick fence nested inside a tilde fence", () => {
  assert.deepStrictEqual(
    texts(
      lines(
        "~~~markdown",
        "```text",
        "pingdotgg/t3code#4379",
        "```",
        "~~~",
        "",
        "Prose resumes here.",
      ),
    ),
    [],
  );
});

it("keeps refusing after a fenced block closes", () => {
  assert.deepStrictEqual(
    texts(
      lines("```text", "pingdotgg/t3code#4379", "```", "", "Rewritten from pingdotgg/t3code#4402."),
    ),
    ["pingdotgg/t3code#4402"],
  );
});

it("treats an unterminated fence the way GitHub renders it", () => {
  assert.deepStrictEqual(texts(lines("```text", "pingdotgg/t3code#4379", "")), []);
});

it("refuses an upstream item URL and accepts it in backticks", () => {
  assert.deepStrictEqual(texts("See https://github.com/pingdotgg/t3code/pull/4379 for the fix."), [
    "https://github.com/pingdotgg/t3code/pull/4379",
  ]);
  assert.deepStrictEqual(
    texts("See `https://github.com/pingdotgg/t3code/pull/4379` for the fix."),
    [],
  );
  assert.deepStrictEqual(texts("github.com/pingdotgg/t3code/issues/4379 is open."), [
    "github.com/pingdotgg/t3code/issues/4379",
  ]);
});

it("keeps a comment anchor and drops the sentence period", () => {
  assert.deepStrictEqual(
    texts("Answered in https://github.com/pingdotgg/t3code/issues/4379#issuecomment-2451."),
    ["https://github.com/pingdotgg/t3code/issues/4379#issuecomment-2451"],
  );
});

it("leaves the upstream repository URL alone", () => {
  assert.deepStrictEqual(texts("The fork sits above https://github.com/pingdotgg/t3code."), []);
});

it("refuses an upstream commit reference in either form", () => {
  assert.deepStrictEqual(texts("Reverted pingdotgg/t3code@1a2b3c4d5e6f in the stack."), [
    "pingdotgg/t3code@1a2b3c4d5e6f",
  ]);
  assert.deepStrictEqual(
    texts("Reverted https://github.com/pingdotgg/t3code/commit/1a2b3c4d5e6f in the stack."),
    ["https://github.com/pingdotgg/t3code/commit/1a2b3c4d5e6f"],
  );
});

it("reports every bare number, including one this fork issued", () => {
  // Verified against GitHub's own Markdown renderer with this fork as context:
  // `#5779` renders as a link to `pingdotgg/t3code`, `GH-4379` does the same, and
  // a number no repository holds renders as plain text. The guard cannot tell the
  // three apart offline, so every bare number is a finding.
  assert.deepStrictEqual(texts("Upstream tracks this in #5779 already."), ["#5779"]);
  assert.deepStrictEqual(texts("Reverted GH-4379 downstream."), ["GH-4379"]);
  assert.deepStrictEqual(texts("Closes #107 in this repository."), ["#107"]);
  // Qualifying it keeps the autolink and renders as `#108`, so the wrap is free.
  assert.deepStrictEqual(texts(`Closes ${FORK_REPO}#108 in this repository.`), []);
  assert.deepStrictEqual(texts("Wrapped `#5779` notifies nobody."), []);
});

it("does not read a bare number out of a longer token", () => {
  assert.deepStrictEqual(texts("Ship v1.2#4379 and x#4379 and other/repo#4379."), []);
  assert.deepStrictEqual(texts("# Heading and ## Subheading carry no number."), []);
  // A space in front is all it takes, which is why the token boundary is tight.
  assert.deepStrictEqual(texts("Ship (#4379) today."), ["#4379"]);
});

it("reports a cross-repo reference whatever case it is written in", () => {
  // GitHub repository identity is case-insensitive, so the mixed-case spelling
  // reaches the same upstream thread as the lowercase one.
  assert.deepStrictEqual(texts("Landed in PingDotGG/T3Code#4379 upstream."), [
    "PingDotGG/T3Code#4379",
  ]);
  assert.deepStrictEqual(texts("See https://GitHub.com/PingDotGG/T3Code/pull/4379 for the fix."), [
    "https://GitHub.com/PingDotGG/T3Code/pull/4379",
  ]);
  assert.deepStrictEqual(texts("Reverted PingDotGG/T3Code@1A2B3C4D5E6F in the stack."), [
    "PingDotGG/T3Code@1A2B3C4D5E6F",
  ]);
  assert.deepStrictEqual(texts("Landed in `PingDotGG/T3Code#4379` upstream."), []);
});

it("does not pair a backslash-escaped backtick as an opener", () => {
  // CommonMark reads `\\``` as a literal backtick, so the run after the citation
  // has nothing to pair with and the citation renders as ordinary prose.
  assert.deepStrictEqual(
    texts("An escaped \\` tick, then pingdotgg/t3code#4379 lands, then a real ` tick."),
    ["pingdotgg/t3code#4379"],
  );
  // An escape stops mattering once a span is open, so this run still closes it.
  assert.deepStrictEqual(
    texts("A real ` tick, then pingdotgg/t3code#4379 lands, then an escaped \\` tick."),
    [],
  );
  // Two backslashes are a literal backslash, so the backtick after them opens.
  assert.deepStrictEqual(texts("Literal backslash \\\\`pingdotgg/t3code#4379` stays code."), []);
});

it("refuses a citation across every block boundary a backtick run cannot cross", () => {
  const across = (...input: ReadonlyArray<string>) => texts(lines(...input));
  const found = ["pingdotgg/t3code#4379"];
  // A setext underline ends the paragraph above it.
  assert.deepStrictEqual(
    across("Prose ` tick", "Heading text", "===", "Para pingdotgg/t3code#4379 ` tick"),
    found,
  );
  // A thematic break interrupts whatever ran into it.
  assert.deepStrictEqual(across("Prose ` tick", "___", "Para pingdotgg/t3code#4379 ` tick"), found);
  // A GFM table parses every cell as its own inline context.
  assert.deepStrictEqual(
    across("| a | b |", "| - | - |", "| ` | x |", "| pingdotgg/t3code#4379 | ` |"),
    found,
  );
  // An HTML block holds raw HTML, where a backtick opens nothing.
  assert.deepStrictEqual(
    across("Prose ` tick", "<div>", "pingdotgg/t3code#4379", "</div>", "More ` tick"),
    found,
  );
  // An ATX heading is a block on both sides, including one with a closing run.
  assert.deepStrictEqual(across("# Heading ` tick #", "Para pingdotgg/t3code#4379 ` tick"), found);
  // A tab reaches the fourth column, which makes the line indented code.
  assert.deepStrictEqual(
    across("Prose ` tick", "", "\t` tick in indented code", "pingdotgg/t3code#4379 ` tick"),
    found,
  );
  // A blockquote may interrupt a paragraph when it quotes deeper.
  assert.deepStrictEqual(across("> One ` tick", "> > Two pingdotgg/t3code#4379 ` tick"), found);
});

it("keeps pairing where GitHub keeps one paragraph", () => {
  // Each of these would be a false positive if the boundary set were widened by
  // shape alone. GitHub renders every citation here inside a code span.
  const paired = (...input: ReadonlyArray<string>) => texts(lines(...input));
  // A paragraph that runs out of a blockquote is a lazy continuation of it.
  assert.deepStrictEqual(
    paired("> Quoted ` tick", "Paragraph pingdotgg/t3code#4379 and ` tick"),
    [],
  );
  // Type 7 HTML cannot interrupt a paragraph, so `<img>` is not a block start.
  assert.deepStrictEqual(
    paired("Prose ` tick", "<img src=x>", "More pingdotgg/t3code#4379 ` tick"),
    [],
  );
  // Emphasis is not a thematic break.
  assert.deepStrictEqual(
    paired("Prose ` tick", "***bold***", "Para pingdotgg/t3code#4379 ` tick"),
    [],
  );
  // A stray pipe with no delimiter row under it is not a table.
  assert.deepStrictEqual(paired("Prose a ` tick | pipe", "more pingdotgg/t3code#4379 ` tick"), []);
  // Within one table cell a run still pairs.
  assert.deepStrictEqual(paired("| a | b |", "| - | - |", "| `pingdotgg/t3code#4379` | ok |"), []);
});

it("masks an indented code block instead of reporting what GitHub prints", () => {
  assert.deepStrictEqual(texts(lines("Prose.", "", "    pingdotgg/t3code#4379")), []);
  assert.deepStrictEqual(texts(lines("Prose.", "", "\tpingdotgg/t3code#4379")), []);
  // Indented code cannot interrupt a paragraph, so a wrapped line stays prose.
  assert.deepStrictEqual(texts(lines("Prose.", "    pingdotgg/t3code#4379")), [
    "pingdotgg/t3code#4379",
  ]);
});

it("keeps a quoted fence open under a line that quotes deeper", () => {
  // The inner line keeps its extra `>` as fence content, so its longer run is
  // not a closer and the citation under it stays masked.
  assert.deepStrictEqual(
    texts(lines("> ```", "> > `````", "> pingdotgg/t3code#4379", "> ```")),
    [],
  );
  assert.deepStrictEqual(texts(lines("> ```", "> > ```", "> pingdotgg/t3code#4379", "> ```")), []);
});

it("masks an HTML comment that is never closed", () => {
  // GitHub hides an unterminated comment through the end of the body.
  assert.deepStrictEqual(
    texts(lines("Rewritten.", "", "<!-- gh-bot:attest", "pingdotgg/t3code#4379")),
    [],
  );
});

it("leaves another repository alone", () => {
  assert.deepStrictEqual(texts("Tracked in RSI-Software/donjor-skills#369 instead."), []);
});

it("ignores an HTML comment, which GitHub never renders", () => {
  assert.deepStrictEqual(
    texts(lines("Rewritten.", "", '<!-- gh-bot:attest {"upstream":"pingdotgg/t3code#4379"} -->')),
    [],
  );
});

it("reports every live reference in body order", () => {
  const body = lines(
    "First pingdotgg/t3code#4402.",
    "`pingdotgg/t3code#4379` stays wrapped.",
    "Then https://github.com/pingdotgg/t3code/issues/4410.",
  );
  assert.deepStrictEqual(findUpstreamReferences(body), [
    { kind: "issue", text: "pingdotgg/t3code#4402", line: 1, column: 7 },
    { kind: "url", text: "https://github.com/pingdotgg/t3code/issues/4410", line: 3, column: 6 },
  ]);
});

it("blanks code without moving any other character", () => {
  const body = lines("Prose `code` prose.", "```", "fenced", "```", "Tail.");
  const masked = maskMarkdownCode(body);
  assert.strictEqual(masked.length, body.length);
  assert.strictEqual(masked.split("\n").length, body.split("\n").length);
  assert.strictEqual(masked.split("\n")[0], "Prose        prose.");
  assert.strictEqual(masked.split("\n").at(-1), "Tail.");
});

it("refuses a citation under a fence opener GitHub reads as indented code", () => {
  // Four columns of indent make the backticks literal, so the line after them
  // is still live prose even though the guard used to call it fenced.
  assert.deepStrictEqual(texts(lines("    ```", "pingdotgg/t3code#4379")), [
    "pingdotgg/t3code#4379",
  ]);
  assert.deepStrictEqual(texts(lines("    ~~~", "pingdotgg/t3code#4379")), [
    "pingdotgg/t3code#4379",
  ]);
});

it("accepts a fence at the three columns CommonMark allows", () => {
  assert.deepStrictEqual(texts(lines("   ```text", "pingdotgg/t3code#4379", "   ```")), []);
});

it("accepts a fence indented four columns under a nested list item", () => {
  assert.deepStrictEqual(
    texts(
      lines(
        "- The survey:",
        "  - Carried rows:",
        "",
        "    ```text",
        "    pingdotgg/t3code#4379",
        "    ```",
      ),
    ),
    [],
  );
});

it("refuses a citation between two paragraphs that each hold a stray backtick", () => {
  // A code span cannot contain a blank line, so these runs never pair and the
  // middle paragraph renders as ordinary prose.
  assert.deepStrictEqual(
    texts(
      lines("Opened with a ` tick.", "", "Landed in pingdotgg/t3code#4379.", "", "Closed ` tick."),
    ),
    ["pingdotgg/t3code#4379"],
  );
});

it("refuses a citation across a heading or a bullet boundary", () => {
  assert.deepStrictEqual(
    texts(lines("Prose ` tick", "# Heading pingdotgg/t3code#4379", "More ` tick")),
    ["pingdotgg/t3code#4379"],
  );
  assert.deepStrictEqual(texts(lines("- One ` tick", "- Two pingdotgg/t3code#4379 ` tick")), [
    "pingdotgg/t3code#4379",
  ]);
});

it("accepts a code span that wraps across a soft line break", () => {
  assert.deepStrictEqual(texts(lines("Wrapped `pingdotgg/t3code#4379", "still code` here.")), []);
});

it("accepts a fence inside a blockquote", () => {
  assert.deepStrictEqual(texts(lines("> ~~~text", "> pingdotgg/t3code#4379", "> ~~~")), []);
  assert.deepStrictEqual(texts(lines("> ```text", "> pingdotgg/t3code#4379", "> ````")), []);
  assert.deepStrictEqual(texts("> Quoted `pingdotgg/t3code#4379` stays wrapped."), []);
});

it("refuses a quoted citation and the prose after the quote ends", () => {
  assert.deepStrictEqual(texts("> See pingdotgg/t3code#4379 upstream."), ["pingdotgg/t3code#4379"]);
  // Leaving the blockquote leaves the fence that opened inside it.
  assert.deepStrictEqual(
    texts(lines("> ```text", "> pingdotgg/t3code#4402", "pingdotgg/t3code#4410")),
    ["pingdotgg/t3code#4410"],
  );
});

it("keeps line and column honest when a masked span holds an astral character", () => {
  assert.deepStrictEqual(findUpstreamReferences(lines("`\u{1F600}`", "pingdotgg/t3code#4379")), [
    { kind: "issue", text: "pingdotgg/t3code#4379", line: 2, column: 1 },
  ]);
  const body = lines("Ship it \u{1F600} `code`", "pingdotgg/t3code#4379");
  assert.strictEqual(maskMarkdownCode(body).length, body.length);
});

it("counts a table-cell escape in the units the scan indexes in", () => {
  // The escaped pipe keeps the cell whole, so the two runs pair and the citation
  // renders as code. Splitting the row by code point instead of by UTF-16 unit
  // moves the escape check off the backslash once an astral character sits in
  // front of it, and the row splits at a pipe GitHub keeps inside the cell.
  assert.deepStrictEqual(
    texts(lines("| a | b |", "| - | - |", "| ` \u{1F600}\\| pingdotgg/t3code#4379 ` |")),
    [],
  );
});

it("leaves an upstream URL that names no item alone", () => {
  assert.deepStrictEqual(
    texts("File at https://github.com/pingdotgg/t3code/issues/new instead."),
    [],
  );
  assert.deepStrictEqual(
    texts("Open https://github.com/pingdotgg/t3code/pull/new/main by hand."),
    [],
  );
  assert.deepStrictEqual(
    texts("Browse https://github.com/pingdotgg/t3code/discussions/categories/ideas first."),
    [],
  );
});

it("names the repository the fork sits above and the fork itself", () => {
  assert.strictEqual(UPSTREAM_REPO, "pingdotgg/t3code");
  assert.strictEqual(FORK_REPO, "RSI-Software/t3code-hyprws");
});
