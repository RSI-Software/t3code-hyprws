#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Spike RSI-712: replays each case through a real Claude Code session, one turn per message,
// with the server's own shared-thread attribution, and grades only the last reply.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  collaboratorAttribution,
  ownerAttributionSpike,
} from "../../apps/server/src/collaborator/CollaboratorMessages.fork.ts";
import { sharedThreadCases, type SharedThreadMessage } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string", default: "claude-haiku-5-5" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    out: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const QUIET = "(listening)";

const attributed = (message: SharedThreadMessage) =>
  message.from === "owner"
    ? ownerAttributionSpike("Jordan", ["Alex"], message.text).text
    : collaboratorAttribution("Alex", message.text).text;

const turn = (cwd: string, text: string, session: string | undefined) => {
  const args = ["-p", "--model", values.model!, "--output-format", "json"];
  if (session) args.push("--resume", session);
  args.push("--disallowedTools", "Bash,Edit,Write,NotebookEdit", "--", text);
  const out = NodeChildProcess.execFileSync("claude", args, { cwd, encoding: "utf8" });
  const parsed = JSON.parse(out) as { result: string; session_id: string; total_cost_usd?: number };
  return {
    reply: parsed.result.trim(),
    session: parsed.session_id,
    cost: parsed.total_cost_usd ?? 0,
  };
};

const rows = [];
for (const fixture of sharedThreadCases.filter((c) => !values.case || values.case.includes(c.id))) {
  for (let sample = 0; sample < Number(values.samples); sample++) {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shared-thread-quiet-"));
    NodeFS.writeFileSync(
      NodePath.join(cwd, "todos.js"),
      "export function addTodo(list, title) {\n  return [...list, { title, done: false }];\n}\n",
    );
    let session: string | undefined;
    let reply = "";
    let cost = 0;
    for (const message of fixture.messages) {
      const result = turn(cwd, attributed(message), session);
      session = result.session;
      reply = result.reply;
      cost += result.cost;
    }
    const got = reply === QUIET ? "quiet" : "reply";
    rows.push({
      id: fixture.id,
      sample,
      expect: fixture.expect,
      got,
      pass: got === fixture.expect,
      cost,
      reply,
    });
    console.log(`${fixture.id} #${sample}: expect ${fixture.expect}, got ${got}`);
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
}
NodeFS.mkdirSync(values.out, { recursive: true });
NodeFS.writeFileSync(NodePath.join(values.out, "results.json"), JSON.stringify(rows, null, 2));
const summary = sharedThreadCases
  .filter((c) => rows.some((row) => row.id === c.id))
  .map((c) => {
    const mine = rows.filter((row) => row.id === c.id);
    const passed = mine.filter((row) => row.pass).length;
    return `| ${c.id} | ${c.expect} | ${passed}/${mine.length} | ${passed * 2 > mine.length ? "pass" : "fail"} |`;
  });
const total = rows.reduce((sum, row) => sum + row.cost, 0);
NodeFS.writeFileSync(
  NodePath.join(values.out, "summary.md"),
  `Model ${values.model}, cost $${total.toFixed(4)}\n\n| Case | Expect | Passed | Verdict |\n| --- | --- | --- | --- |\n${summary.join("\n")}\n`,
);
console.log(NodeFS.readFileSync(NodePath.join(values.out, "summary.md"), "utf8"));
