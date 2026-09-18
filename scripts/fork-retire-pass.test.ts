// @effect-diagnostics nodeBuiltinImport:off - Throwaway repositories use Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  OVERBREADTH_FRACTION,
  parseWorklist,
  parseWorklistLine,
  renderRetirePass,
  retirePass,
  retirePassSummary,
  type RetirePassRow,
  type RetirePassStatus,
} from "./fork-retire-pass.ts";
import { SystemRunner, type CommandRunner } from "./fork-sync.ts";

// Each case builds a throwaway Git repository: a base commit, a fork branch whose commits carry the
// worklist subjects, and a target branch playing the upstream tree the evidence must come from.
const buildRepository = (root: string): void => {
  const git = (args: ReadonlyArray<string>): void => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  const write = (path: string, contents: string): void => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), contents);
  };
  git(["init", "--quiet", "--initial-branch", "main"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "retire-pass test"]);
  write("README.md", "base\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  git(["checkout", "-b", "target"]);
  // Upstream now owns the seam: the fork's identifier is defined in product source.
  write(
    "src/owned.ts",
    "export const frobnicatorWidgetName = 'owned';\nexport type reticulatorSurfaceKind = string;\n",
  );
  // Same identifier in prose and a dot directory: the scoped probe must not read either back.
  write("docs/notes.md", "export const frobnicatorWidgetName\n");
  write(".repos/vendored.ts", "export const frobnicatorWidgetName\n");
  git(["add", "."]);
  git(["commit", "-m", "target tree"]);
  git(["checkout", "-b", "fork", "main"]);
  write("src/fork-seam.ts", "export const frobnicatorWidgetName = 'fork';\n");
  git(["add", "."]);
  git(["commit", "-m", "feat(seam): frobnicatorWidgetName reticulator carries the boundary"]);
  write("src/other-seam.ts", "export const quixoticallyUnmentionedHandle = 'fork';\n");
  git(["add", "."]);
  git(["commit", "-m", "feat(seam): quixoticallyUnmentionedHandle stays fork-owned"]);
  git(["checkout", "main"]);
};

const repositories: Array<string> = [];
const makeRepository = (prefix: string): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  repositories.push(root);
  buildRepository(root);
  return root;
};

afterEach(() => {
  for (const root of repositories.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("parseWorklistLine", () => {
  it("reads a bare subject", () => {
    expect(parseWorklistLine("feat(seam): a subject")).toBe("feat(seam): a subject");
  });

  it("strips markdown checkboxes, code spans, and ledger annotations", () => {
    expect(
      parseWorklistLine(
        "- [ ] `refactor(web): share project pathname parsing` (ledger: 2, 2 walks; extraction)",
      ),
    ).toBe("refactor(web): share project pathname parsing");
    expect(
      parseWorklistLine(
        "- [x] refactor(agents): custom agents behind fork-owned boundaries (ledger: 13)",
      ),
    ).toBe("refactor(agents): custom agents behind fork-owned boundaries");
  });

  it("ignores blank lines and comments", () => {
    expect(parseWorklistLine("")).toBe("");
    expect(parseWorklistLine("   ")).toBe("");
    expect(parseWorklistLine("# a note")).toBe("");
  });
});

describe("parseWorklist", () => {
  it("keeps order and drops noise", () => {
    expect(parseWorklist("# header\n\n- [ ] a subject\nplain subject\n")).toEqual([
      "a subject",
      "plain subject",
    ]);
  });
});

describe("retirePass", () => {
  const runner: CommandRunner = new SystemRunner();

  it("emits a candidate with its evidence site when the target defines the fork identifier", () => {
    const root = makeRepository("fork-retire-pass-candidate-");
    const rows = retirePass(runner, root, {
      worklist: ["feat(seam): frobnicatorWidgetName reticulator carries the boundary"],
      base: "main",
      source: "fork",
      target: "target",
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("retire-candidate");
    expect(row.identifiers).toContain("frobnicatorWidgetName");
    expect(row.sites).toEqual([
      {
        identifier: "frobnicatorWidgetName",
        location: expect.stringMatching(/^src\/owned\.ts:\d+$/),
      },
    ]);
    expect(row.verdict).toBe("pending");
  });

  it("reads no-evidence where the target never defines the identifier", () => {
    const root = makeRepository("fork-retire-pass-none-");
    const rows = retirePass(runner, root, {
      worklist: ["feat(seam): quixoticallyUnmentionedHandle stays fork-owned"],
      base: "main",
      source: "fork",
      target: "target",
    });
    expect(rows[0]?.status).toBe("no-evidence");
    expect(rows[0]?.sites).toEqual([]);
  });

  it("reports a subject missing from the range instead of guessing", () => {
    const root = makeRepository("fork-retire-pass-missing-");
    const rows = retirePass(runner, root, {
      worklist: ["refactor(gone): folded away long ago"],
      base: "main",
      source: "fork",
      target: "target",
    });
    expect(rows[0]?.status).toBe("not-in-range");
    expect(rows[0]?.verdict).toBe("pending");
  });

  it("reads the human verdict back from the retirement ledger keyed by subject", () => {
    const root = makeRepository("fork-retire-pass-verdict-");
    const ledger = NodePath.join(root, "docs/internals/fork-delta.md");
    NodeFS.mkdirSync(NodePath.dirname(ledger), { recursive: true });
    const subject = "feat(seam): frobnicatorWidgetName reticulator carries the boundary";
    NodeFS.writeFileSync(
      ledger,
      [
        "## Retired",
        "",
        "| Fork commit | Domain | Upstream replacement | Retired at |",
        "| --- | --- | --- | --- |",
        `| ${subject} | fork-meta | upstream owns it | v0.0.42 |`,
        "",
        "## Kept",
        "",
        "| Fork commit | Domain | Reason | Reviewed at |",
        "| --- | --- | --- | --- |",
        "| other subject | fork-meta | still fork-owned | v0.0.42 |",
        "",
      ].join("\n"),
    );
    const rows = retirePass(runner, root, {
      worklist: [subject],
      base: "main",
      source: "fork",
      target: "target",
    });
    expect(rows[0]?.verdict).toBe("retire");
  });
});

describe("retirePassSummary", () => {
  const row = (status: RetirePassStatus, verdict: "pending" = "pending"): RetirePassRow => ({
    subject: "s",
    status,
    identifiers: [],
    sites: [],
    verdict,
  });

  it("counts worklist, probed, candidates, and pending verdicts", () => {
    const summary = retirePassSummary([
      row("retire-candidate"),
      row("no-evidence"),
      row("not-in-range"),
    ]);
    expect(summary).toContain("worklist: 3 subject(s), 2 probed, 1 not in range");
    expect(summary).toContain("retire candidates: 1 of 2 probed (50%)");
    expect(summary).toContain("awaiting human verdict: 3");
  });

  it("warns when the candidate share reaches the overbreadth threshold", () => {
    const rows = Array.from({ length: 4 }, () => row("retire-candidate"));
    const summary = retirePassSummary(rows);
    expect(summary).toContain("WARNING");
    expect(summary).toContain("RSI-Software/t3code-hyprws#688");
    expect(OVERBREADTH_FRACTION).toBe(0.5);
  });

  it("stays quiet when the candidate share is below the threshold", () => {
    const summary = retirePassSummary([
      row("retire-candidate"),
      row("no-evidence"),
      row("no-evidence"),
    ]);
    expect(summary).not.toContain("WARNING");
  });
});

describe("renderRetirePass", () => {
  it("renders one row per subject with evidence sites", () => {
    const rendered = renderRetirePass([
      {
        subject: "feat(seam): a subject",
        status: "retire-candidate",
        commit: "0123456789abcdef0123456789abcdef01234567",
        identifiers: ["frobnicatorWidgetName"],
        sites: [{ identifier: "frobnicatorWidgetName", location: "src/owned.ts:1" }],
        verdict: "pending",
      },
    ]);
    expect(rendered).toContain(
      "- [retire-candidate] feat(seam): a subject @ 0123456789 — verdict: pending",
    );
    expect(rendered).toContain("frobnicatorWidgetName @ src/owned.ts:1");
  });
});
