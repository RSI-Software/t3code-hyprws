import { assert, it } from "@effect/vitest";

import {
  parseArgs,
  UsageError,
  validateArtifact,
  ValidationError,
  type WorkflowRun,
} from "./fork-rebase-report-artifact.ts";

const run: WorkflowRun = {
  databaseId: 123,
  headSha: "a".repeat(40),
  conclusion: "success",
  status: "completed",
  workflowName: "hyprws rebase report",
  url: "https://github.com/RSI-Software/t3code-hyprws/actions/runs/123",
};

const report = {
  schemaVersion: 1,
  generatedBy: "vp run fork:rebase-report",
  sharedBase: { sha: "b".repeat(40), shortSha: "bbbbbbb", upstreamTags: [] },
  upstream: {
    ref: "upstream/main",
    sha: "c".repeat(40),
    shortSha: "ccccccc",
    repository: {
      slug: "pingdotgg/t3code",
      webUrl: "https://github.com/pingdotgg/t3code",
    },
  },
  hyprws: {
    ref: "origin/hyprws",
    sha: run.headSha,
    shortSha: "aaaaaaa",
    repository: {
      slug: "RSI-Software/t3code-hyprws",
      webUrl: "https://github.com/RSI-Software/t3code-hyprws",
    },
  },
};

const markdown = `# Fork rebase orientation

- Source: https://github.com/RSI-Software/t3code-hyprws/tree/${run.headSha}
- Target: https://github.com/pingdotgg/t3code/tree/${report.upstream.sha}
`;

it("parses explicit and default artifact selection", () => {
  assert.deepStrictEqual(parseArgs([]), {
    runId: null,
    output: ".dump/runs/fork-rebase-report",
  });
  assert.deepStrictEqual(parseArgs(["--run", "123", "--output", ".dump/report"]), {
    runId: "123",
    output: ".dump/report",
  });
  assert.throws(() => parseArgs(["--run", "latest"]), UsageError);
  assert.throws(() => parseArgs(["--unknown"]), UsageError);
});

it("accepts a report tied to the successful workflow head", () => {
  assert.doesNotThrow(() => validateArtifact(JSON.stringify(report), markdown, run));
});

it("rejects the malformed repository links produced by the workflow", () => {
  const malformed = {
    ...report,
    upstream: {
      ...report.upstream,
      repository: {
        slug: null,
        webUrl: "https://https///github.com/pingdotgg/t3code",
      },
    },
  };
  assert.throws(() => validateArtifact(JSON.stringify(malformed), markdown, run), ValidationError);
});

it("rejects an artifact generated from a different workflow head", () => {
  const mismatched = structuredClone(report);
  mismatched.hyprws.sha = "d".repeat(40);
  assert.throws(
    () => validateArtifact(JSON.stringify(mismatched), markdown, run),
    /does not match run/,
  );
});
