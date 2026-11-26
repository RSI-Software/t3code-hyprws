#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalConsole:off
// Replays each case through a real Claude session, one turn per message, with the server's own
// shared-thread attribution, and grades what happens to the last message.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  collaboratorAttribution,
  hostAttribution,
  QUIET_MARKER,
} from "../../apps/server/src/collaborator/CollaboratorMessages.fork.ts";
import { sharedThreadCases, type SharedThreadMessage } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    arm: { type: "string", default: "current" },
    model: { type: "string", default: "claude-haiku-5-5" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "6" },
    out: { type: "string" },
    baseline: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const arm = values.arm!;
if (arm !== "current" && arm !== "rsi-712") throw new Error("--arm is current or rsi-712.");
const model = values.model!;
for (const id of values.case ?? []) {
  if (!sharedThreadCases.some((c) => c.id === id)) throw new Error(`Unknown case id: ${id}.`);
}
const outDir = NodePath.resolve(values.out);
NodeFS.mkdirSync(outDir, { recursive: true });

const HOST = "Jordan";
const COLLABORATOR = "Alex";

// The control: RSI-712's rule, the shipped text these cases were written against.
const rule712 = (people: string) =>
  `This thread is shared: ${people} read it and your replies live, and people here also talk to each other. ` +
  `Reply only when the message is for you: it asks you (the agent) to do, check, explain or decide something, or names you. ` +
  `When it is people talking to each other (addressed to a person by name, a question only a person can answer, thanks, agreement, small talk, plans between them), ` +
  `do nothing: no tools, no work, and reply with exactly ${QUIET_MARKER} and nothing else.`;
const attributed712 = (message: SharedThreadMessage) =>
  message.from === "owner"
    ? `[${HOST}, the owner of this thread, wrote the message below. ${rule712(`${HOST} and ${COLLABORATOR}`)}]\n\n${message.text}`
    : `[${COLLABORATOR}, a collaborator the owner shared this thread with, wrote the message below. ${rule712(`the owner and ${COLLABORATOR}`)}]\n\n${message.text}`;

const attributed = (message: SharedThreadMessage) =>
  arm === "rsi-712"
    ? attributed712(message)
    : message.from === "owner"
      ? hostAttribution(HOST, [COLLABORATOR], message.text).text
      : collaboratorAttribution(COLLABORATOR, message.text).text;

// Keep the developer's CLAUDE.md, hooks and MCP servers out of the agent's session; auth stays.
const claudeSettings = process.env.EVAL_CLAUDE_SETTINGS;

interface Turn {
  readonly reply: string;
  readonly session: string;
  readonly costUsd: number;
}

const claudeTurn = (cwd: string, text: string, session: string | undefined) =>
  new Promise<Turn>((resolve, reject) => {
    const args = ["-p", "--model", model, "--output-format", "json"];
    if (claudeSettings) args.push("--setting-sources", "", "--settings", claudeSettings);
    args.push("--strict-mcp-config", "--disallowedTools", "Bash,Edit,Write,NotebookEdit");
    if (session) args.push("--resume", session);
    args.push("--", text);
    const child = NodeChildProcess.execFile(
      "claude",
      args,
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`claude failed: ${(stderr || stdout).slice(-800)}`));
        // A notice may precede the JSON result line.
        const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
          result?: string;
          session_id: string;
          total_cost_usd?: number;
        };
        resolve({
          reply: (result.result ?? "").trim(),
          session: result.session_id,
          costUsd: result.total_cost_usd ?? 0,
        });
      },
    );
    child.stdin?.end();
  });

const gotOf = (turn: Turn) => (turn.reply === QUIET_MARKER ? "quiet" : "reply");

const runSample = async (fixture: (typeof sharedThreadCases)[number], sample: number) => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shared-thread-quiet-"));
  NodeFS.writeFileSync(
    NodePath.join(cwd, "todos.js"),
    "export function addTodo(list, title) {\n  return [...list, { title, done: false }];\n}\n",
  );
  let session: string | undefined;
  const lines: Array<{ expect?: "quiet" | "reply"; turn: Turn }> = [];
  try {
    for (const message of fixture.messages) {
      const turn = await claudeTurn(cwd, attributed(message), session);
      session = turn.session;
      lines.push({ ...(message.expect ? { expect: message.expect } : {}), turn });
    }
  } finally {
    // The eval's sessions should not crowd the developer's own resume lists.
    const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    NodeFS.rmSync(NodePath.join(NodeOS.homedir(), ".claude", "projects", project), {
      recursive: true,
      force: true,
    });
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
  const got = gotOf(lines.at(-1)!.turn);
  return {
    arm,
    model,
    id: fixture.id,
    kind: fixture.kind,
    sample,
    expect: fixture.expect,
    got,
    pass: got === fixture.expect,
    reply: lines.at(-1)!.turn.reply,
    costUsd: lines.reduce((sum, line) => sum + line.turn.costUsd, 0),
    history: lines
      .slice(0, -1)
      .flatMap((line) =>
        line.expect === undefined ? [] : [{ expect: line.expect, got: gotOf(line.turn) }],
      ),
  };
};
type Row = Awaited<ReturnType<typeof runSample>>;

const jobs = sharedThreadCases
  .filter((c) => !values.case || values.case.includes(c.id))
  .flatMap((fixture) =>
    Array.from({ length: Number(values.samples) }, (_, sample) => ({ fixture, sample })),
  );
const rows: Array<Row> = [];
const failures: Array<{ id: string; sample: number; error: string }> = [];
let next = 0;
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < jobs.length) {
      const { fixture, sample } = jobs[next++]!;
      try {
        const row = await runSample(fixture, sample);
        rows.push(row);
        console.log(`${row.id} #${sample}: expect ${row.expect}, got ${row.got}`);
      } catch (error) {
        failures.push({ id: fixture.id, sample, error: String(error) });
        console.log(`${fixture.id} #${sample}: error ${String(error).slice(0, 200)}`);
      }
    }
  }),
);
rows.sort((a, b) => a.id.localeCompare(b.id) || a.sample - b.sample);
NodeFS.writeFileSync(NodePath.join(outDir, "results.json"), JSON.stringify(rows, null, 2));
if (failures.length > 0)
  NodeFS.writeFileSync(NodePath.join(outDir, "failures.json"), JSON.stringify(failures, null, 2));

const history = rows.flatMap((row) => row.history);
const count = (lines: ReadonlyArray<{ expect: string; got: string }>, expect: string) =>
  `${lines.filter((line) => line.expect === expect && line.got !== expect).length}/${lines.filter((line) => line.expect === expect).length}`;
const totalCostUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);

const baseline = values.baseline
  ? (JSON.parse(NodeFS.readFileSync(values.baseline, "utf8")) as ReadonlyArray<Row>)
  : [];
const verdict = (mine: ReadonlyArray<Row>) => {
  const passed = mine.filter((row) => row.pass).length;
  return `${passed}/${mine.length} ${passed * 2 > mine.length ? "pass" : "**fail**"}`;
};
const caseRows = sharedThreadCases
  .filter((c) => rows.some((row) => row.id === c.id))
  .map((c) => {
    const base = baseline.filter((row) => row.id === c.id);
    return `| ${c.id} | ${c.kind} | ${c.expect} | ${verdict(rows.filter((row) => row.id === c.id))} |${values.baseline ? ` ${base.length ? verdict(base) : "-"} |` : ""}`;
  });
const summary = [
  `Arm ${arm}, model ${model}: ${rows.length} samples, ${failures.length} errors, cost $${totalCostUsd.toFixed(4)}`,
  "",
  "| Lines | Misses (ask, no reply) | Unwanted (people, reply) |",
  "| --- | --- | --- |",
  `| Graded (last) | ${count(rows, "reply")} | ${count(rows, "quiet")} |`,
  `| History | ${count(history, "reply")} | ${count(history, "quiet")} |`,
  "",
  `| Case | Kind | Expect | Passed |${values.baseline ? " Baseline |" : ""}`,
  `| --- | --- | --- | --- |${values.baseline ? " --- |" : ""}`,
  ...caseRows,
  "",
].join("\n");
NodeFS.writeFileSync(NodePath.join(outDir, "summary.md"), summary);
console.log(summary);
