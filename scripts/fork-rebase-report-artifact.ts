#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone GitHub artifact check runs before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import { runCommandText } from "./lib/fork-command.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";

const DEFAULT_REPOSITORY = FORK_REPOSITORY;
const DEFAULT_OUTPUT = ".dump/runs/fork-rebase-report";
const WORKFLOW = "hyprws-rebase-report.yml";
const WORKFLOW_NAME = "hyprws rebase report";
const ARTIFACT_NAME = "fork-rebase-report";
const EXPECTED_REPOSITORIES = {
  upstream: {
    slug: "pingdotgg/t3code",
    webUrl: "https://github.com/pingdotgg/t3code",
  },
  hyprws: {
    slug: FORK_REPOSITORY,
    webUrl: `https://github.com/${FORK_REPOSITORY}`,
  },
} as const;

const HELP = `Usage: vp run fork:rebase-report:artifact [options]

Download and validate a hyprws rebase-report workflow artifact.

Options:
  --run <id>             Workflow run id (default: latest successful run)
  --output <path>        Run archive root relative to the repository
                         (default: .dump/runs/fork-rebase-report)
  -h, --help             Show help

Writes the artifact to <output>/<run-id>/ and reuses an existing immutable run.
Exits 0 when valid, 1 on download or validation failure, and 2 on invalid usage.
`;

export interface ArtifactOptions {
  readonly runId: string | null;
  readonly output: string;
}

export interface WorkflowRun {
  readonly databaseId: number;
  readonly headSha: string;
  readonly conclusion: string;
  readonly status: string;
  readonly workflowName: string;
  readonly url: string;
}

interface CommandReader {
  readonly run: (command: string, args: ReadonlyArray<string>, cwd: string) => string;
}

export { UsageError } from "./lib/fork-cli.ts";

export class ValidationError extends Error {}

const defaultOptions = (): ArtifactOptions => ({
  runId: null,
  output: DEFAULT_OUTPUT,
});

export const parseArtifactArgs = (argv: ReadonlyArray<string>): ArtifactOptions => {
  const options = { ...defaultOptions() };
  const seen = new Set<string>();
  const valueFlags = new Set(["--run", "--output"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h" || argument === "--help") continue;
    if (!valueFlags.has(argument)) throw new UsageError(`unknown option: ${argument}`);
    if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--run") options.runId = value;
    else options.output = value;
  }

  if (options.runId !== null && !/^\d+$/.test(options.runId)) {
    throw new UsageError("--run must be a numeric workflow run id");
  }
  if (options.output.length === 0) throw new UsageError("--output cannot be empty");
  return options;
};

class SystemCommands implements CommandReader {
  run(command: string, args: ReadonlyArray<string>, cwd: string): string {
    return runCommandText(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  }
}

const parseWorkflowRun = (raw: string): WorkflowRun => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new ValidationError("GitHub returned malformed workflow metadata");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.databaseId !== "number" ||
    typeof record.headSha !== "string" ||
    typeof record.conclusion !== "string" ||
    typeof record.status !== "string" ||
    typeof record.workflowName !== "string" ||
    typeof record.url !== "string"
  ) {
    throw new ValidationError("GitHub returned incomplete workflow metadata");
  }
  return record as unknown as WorkflowRun;
};

const latestSuccessfulRun = (
  commands: CommandReader,
  repository: string,
  cwd: string,
): WorkflowRun => {
  const raw = commands.run(
    "gh",
    [
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      WORKFLOW,
      "--status",
      "success",
      "--limit",
      "1",
      "--json",
      "databaseId,headSha,conclusion,status,workflowName,url",
    ],
    cwd,
  );
  const runs: unknown = JSON.parse(raw);
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new ValidationError(`no successful ${WORKFLOW_NAME} run found`);
  }
  return parseWorkflowRun(JSON.stringify(runs[0]));
};

const explicitRun = (
  commands: CommandReader,
  repository: string,
  runId: string,
  cwd: string,
): WorkflowRun =>
  parseWorkflowRun(
    commands.run(
      "gh",
      [
        "run",
        "view",
        runId,
        "--repo",
        repository,
        "--json",
        "databaseId,headSha,conclusion,status,workflowName,url",
      ],
      cwd,
    ),
  );

const resolveInsideRoot = (root: string, relativePath: string): string => {
  const resolved = NodePath.resolve(root, relativePath);
  const relative = NodePath.relative(root, resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new UsageError(`output path must stay inside the repository: ${relativePath}`);
  }
  return resolved;
};

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const validateArtifact = (
  jsonContents: string,
  markdownContents: string,
  run: WorkflowRun,
): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContents);
  } catch {
    throw new ValidationError("fork-rebase-report.json is not valid JSON");
  }
  const report = requireRecord(parsed, "report");
  if (report.schemaVersion !== 3 || report.generatedBy !== "vp run fork:rebase-report") {
    throw new ValidationError("report schema or generator is unsupported");
  }
  const upstream = requireRecord(report.upstream, "upstream lane");
  const hyprws = requireRecord(report.hyprws, "hyprws lane");
  if (hyprws.sha !== run.headSha) {
    throw new ValidationError(
      `artifact head ${String(hyprws.sha)} does not match run ${run.headSha}`,
    );
  }

  for (const [laneName, expected] of Object.entries(EXPECTED_REPOSITORIES)) {
    const lane = laneName === "upstream" ? upstream : hyprws;
    const repository = requireRecord(lane.repository, `${laneName} repository`);
    if (repository.slug !== expected.slug || repository.webUrl !== expected.webUrl) {
      throw new ValidationError(
        `${laneName} repository is malformed: ${String(repository.webUrl)}`,
      );
    }
    if (!markdownContents.includes(`${expected.webUrl}/tree/${String(lane.sha)}`)) {
      throw new ValidationError(`${laneName} tree link is missing from Markdown`);
    }
  }

  if (markdownContents.includes("https://https")) {
    throw new ValidationError("Markdown contains malformed https://https links");
  }
};

const readArtifact = (directory: string, run: WorkflowRun): void => {
  const jsonPath = NodePath.join(directory, "fork-rebase-report.json");
  const markdownPath = NodePath.join(directory, "fork-rebase-report.md");
  if (!NodeFS.existsSync(jsonPath) || !NodeFS.existsSync(markdownPath)) {
    throw new ValidationError(`artifact is incomplete: ${directory}`);
  }
  validateArtifact(
    NodeFS.readFileSync(jsonPath, "utf8"),
    NodeFS.readFileSync(markdownPath, "utf8"),
    run,
  );
};

const commandErrorMessage = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return null;
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  if (typeof stderr === "string") return stderr.trim();
  if (stderr instanceof Uint8Array) return Buffer.from(stderr).toString("utf8").trim();
  return null;
};

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  commands: CommandReader = new SystemCommands(),
): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    const options = parseArtifactArgs(argv);
    const root = commands.run("git", ["rev-parse", "--show-toplevel"], cwd).trim();
    const workflowRun =
      options.runId === null
        ? latestSuccessfulRun(commands, DEFAULT_REPOSITORY, root)
        : explicitRun(commands, DEFAULT_REPOSITORY, options.runId, root);
    if (
      workflowRun.workflowName !== WORKFLOW_NAME ||
      workflowRun.status !== "completed" ||
      workflowRun.conclusion !== "success"
    ) {
      throw new ValidationError(
        `run ${String(workflowRun.databaseId)} is not a successful ${WORKFLOW_NAME} run`,
      );
    }

    const archiveRoot = resolveInsideRoot(root, options.output);
    const artifactDirectory = NodePath.join(archiveRoot, String(workflowRun.databaseId));
    const jsonPath = NodePath.join(artifactDirectory, "fork-rebase-report.json");
    const markdownPath = NodePath.join(artifactDirectory, "fork-rebase-report.md");
    const exists = NodeFS.existsSync(artifactDirectory);
    if (!exists) {
      NodeFS.mkdirSync(artifactDirectory, { recursive: true });
      commands.run(
        "gh",
        [
          "run",
          "download",
          String(workflowRun.databaseId),
          "--repo",
          DEFAULT_REPOSITORY,
          "--name",
          ARTIFACT_NAME,
          "--dir",
          artifactDirectory,
        ],
        root,
      );
    }
    readArtifact(artifactDirectory, workflowRun);
    process.stdout.write(
      `${exists ? "reused" : "downloaded"}: ${NodePath.relative(root, artifactDirectory)}\n`,
    );
    process.stdout.write(`valid: ${NodePath.relative(root, markdownPath)}\n`);
    process.stdout.write(`json: ${NodePath.relative(root, jsonPath)}\n`);
    process.stdout.write(`run: ${workflowRun.url}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    const message =
      commandErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
    process.stderr.write(`failed: ${message}\n`);
    return 1;
  }
};

export { parseArtifactArgs as parseArgs };

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
