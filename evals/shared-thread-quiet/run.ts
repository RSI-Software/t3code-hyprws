#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalConsole:off
// Spike RSI-712/714: replays each case through real agent sessions, one turn per message, with the
// server's own shared-thread attribution, and grades only what happens to the last message.
// Arms: the agent judges in its turn (marker712, marker, tool), or a router decides first (router).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import {
  collaboratorAttribution,
  ownerAttributionSpike,
  QUIET_MARKER_SPIKE,
  QUIET_TOOL_SPIKE,
  type SharedThreadModeSpike,
} from "../../apps/server/src/collaborator/CollaboratorMessages.fork.ts";
import {
  peopleLinesPromptSpike,
  routeSharedThreadLineSpike,
  type SharedThreadLineSpike,
} from "../../apps/server/src/collaborator/SharedThreadRouter.fork.ts";
import * as ClaudeTextGeneration from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { sharedThreadCases, type SharedThreadMessage } from "./cases.ts";

const ARMS = ["marker712", "marker", "tool", "router"] as const;
type Arm = (typeof ARMS)[number];

const { values } = NodeUtil.parseArgs({
  options: {
    arm: { type: "string", default: "tool" },
    model: { type: "string", default: "claude-haiku-5-5" },
    "router-model": { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "6" },
    out: { type: "string" },
    baseline: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const arm = values.arm as Arm;
if (!ARMS.includes(arm)) throw new Error(`--arm is one of ${ARMS.join(", ")}.`);
const model = values.model!;
const routerModel = values["router-model"] ?? model;
const isClaude = (id: string) => id.startsWith("claude");
for (const id of values.case ?? []) {
  if (!sharedThreadCases.some((c) => c.id === id)) throw new Error(`Unknown case id: ${id}.`);
}
const outDir = NodePath.resolve(values.out);
NodeFS.mkdirSync(outDir, { recursive: true });

const OWNER = "Jordan";
const COLLABORATOR = "Alex";
const nameOf = (message: SharedThreadMessage) => (message.from === "owner" ? OWNER : COLLABORATOR);
const attributed = (message: SharedThreadMessage, mode: SharedThreadModeSpike) =>
  message.from === "owner"
    ? ownerAttributionSpike(OWNER, [COLLABORATOR], message.text, mode).text
    : collaboratorAttribution(COLLABORATOR, message.text, mode).text;

const execFile = (file: string, args: ReadonlyArray<string>, cwd: string) =>
  new Promise<{ stdout: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    // Codex reads stdin until it closes, even with the prompt in argv.
    const child = NodeChildProcess.execFile(
      file,
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${file} failed: ${stderr.slice(-800)}`, { cause: error }))
          : resolve({ stdout, ms: Date.now() - started }),
    );
    child.stdin?.end();
  });

interface AgentTurn {
  readonly reply: string;
  readonly quietTool: boolean;
  readonly session: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly ms: number;
}

const QUIET_MCP = NodePath.join(import.meta.dirname, "stay-quiet-mcp.ts");
// Keep the developer's CLAUDE.md, hooks and MCP servers out of the agent's session; auth stays.
const claudeSettings = process.env.EVAL_CLAUDE_SETTINGS;

const claudeTurn = async (
  cwd: string,
  text: string,
  session: string | undefined,
  withTool: boolean,
): Promise<AgentTurn> => {
  const args = ["-p", "--model", model, "--output-format", "stream-json", "--verbose"];
  if (claudeSettings) args.push("--setting-sources", "", "--settings", claudeSettings);
  args.push("--strict-mcp-config", "--disallowedTools", "Bash,Edit,Write,NotebookEdit");
  if (withTool) {
    args.push(
      "--mcp-config",
      JSON.stringify({ mcpServers: { t3: { command: "node", args: [QUIET_MCP] } } }),
      "--allowedTools",
      `mcp__t3__${QUIET_TOOL_SPIKE}`,
    );
  }
  if (session) args.push("--resume", session);
  args.push("--", text);
  const { stdout, ms } = await execFile("claude", args, cwd);
  let quietTool = false;
  let result:
    | { result?: string; session_id: string; total_cost_usd?: number; usage?: Usage }
    | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line) as {
      type: string;
      message?: { content?: ReadonlyArray<{ type: string; name?: string }> };
    };
    if (event.type === "assistant") {
      quietTool ||= (event.message?.content ?? []).some(
        (block) => block.type === "tool_use" && block.name?.endsWith(QUIET_TOOL_SPIKE),
      );
    }
    if (event.type === "result") result = event as unknown as typeof result;
  }
  if (!result) throw new Error("Claude printed no result.");
  return {
    reply: (result.result ?? "").trim(),
    quietTool,
    session: result.session_id,
    costUsd: result.total_cost_usd ?? 0,
    tokens: usageTokens(result.usage),
    ms,
  };
};

interface Usage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}
const usageTokens = (usage: Usage | undefined) =>
  (usage?.input_tokens ?? 0) +
  (usage?.output_tokens ?? 0) +
  (usage?.cache_creation_input_tokens ?? 0) +
  (usage?.cache_read_input_tokens ?? 0);

const CODEX_ISOLATION = [
  "-c",
  "features.connectors=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.apps=false",
  "-c",
  "features.hooks=false",
  "-c",
  "features.codex_hooks=false",
  "-c",
  'sandbox_mode="read-only"',
];
// The developer's own MCP servers stay off, as the server's Codex text generation does.
const codexMcpOff = isClaude(model)
  ? []
  : (
      JSON.parse(
        NodeChildProcess.execFileSync(
          "codex",
          [...CODEX_ISOLATION, "mcp", "list", "--json"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ),
      ) as ReadonlyArray<{ name: string; enabled: boolean }>
    )
      .filter((server) => server.enabled && !/[.=]/.test(server.name))
      .flatMap((server) => ["-c", `mcp_servers.${server.name}.enabled=false`]);

const codexTurn = async (
  cwd: string,
  text: string,
  session: string | undefined,
  withTool: boolean,
): Promise<AgentTurn> => {
  const args = ["exec", ...(session ? ["resume", session] : [])];
  args.push("--json", "--skip-git-repo-check", "-m", model, ...CODEX_ISOLATION, ...codexMcpOff);
  if (withTool) {
    args.push(
      "-c",
      'mcp_servers.t3.command="node"',
      "-c",
      `mcp_servers.t3.args=[${JSON.stringify(QUIET_MCP)}]`,
    );
  }
  args.push("--", text);
  const { stdout, ms } = await execFile("codex", args, cwd);
  let thread = session ?? "";
  let reply = "";
  let quietTool = false;
  let tokens = 0;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const event = JSON.parse(line) as {
      type: string;
      thread_id?: string;
      item?: { type: string; text?: string; tool?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (event.type === "thread.started" && event.thread_id) thread = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message")
      reply = event.item.text ?? "";
    if (event.type === "item.completed" && event.item?.type === "mcp_tool_call")
      quietTool ||= event.item.tool === QUIET_TOOL_SPIKE;
    if (event.type === "turn.completed")
      tokens += (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0);
  }
  return { reply: reply.trim(), quietTool, session: thread, costUsd: 0, tokens, ms };
};

const agentTurn = isClaude(model) ? claudeTurn : codexTurn;

// The router runs through the server's own text generation. A shim around the CLI records what
// each call cost: Claude's JSON envelope, or the token count Codex prints on stderr.
const shimDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shared-thread-router-"));
const shim = NodePath.join(shimDir, isClaude(routerModel) ? "claude" : "codex");
NodeFS.writeFileSync(
  shim,
  isClaude(routerModel)
    ? `#!/usr/bin/env bash\nout=$(claude "$@"); code=$?\nprintf '%s\\n' "$out" >> "$ROUTER_LOG"\nprintf '%s' "$out"\nexit $code\n`
    : `#!/usr/bin/env bash\ncodex "$@" 2> >(tee -a "$ROUTER_LOG" >&2)\n`,
  { mode: 0o755 },
);
const routerRuntime = ManagedRuntime.make(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-shared-thread-router-" }).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
  ),
);

const routeLine = async (
  cwd: string,
  log: string,
  recent: ReadonlyArray<SharedThreadLineSpike>,
  line: SharedThreadLineSpike,
) => {
  const before = NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").length : 0;
  const started = Date.now();
  const environment = { ...process.env, ROUTER_LOG: log };
  const route = await routerRuntime.runPromise(
    Effect.gen(function* () {
      const textGeneration = isClaude(routerModel)
        ? yield* ClaudeTextGeneration.makeClaudeTextGeneration(
            yield* Schema.decodeEffect(ClaudeSettings)({ binaryPath: shim }),
            environment,
          )
        : yield* CodexTextGeneration.makeCodexTextGeneration(
            yield* Schema.decodeEffect(CodexSettings)({ binaryPath: shim }),
            environment,
          );
      return yield* routeSharedThreadLineSpike(textGeneration, {
        cwd,
        modelSelection: {
          instanceId: ProviderInstanceId.make(isClaude(routerModel) ? "claudeAgent" : "codex"),
          model: routerModel,
        },
        people: [OWNER, COLLABORATOR],
        recent,
        line,
      });
    }),
  );
  const ms = Date.now() - started;
  const added = NodeFS.readFileSync(log, "utf8").slice(before);
  let costUsd = 0;
  let tokens = 0;
  if (isClaude(routerModel)) {
    for (const entry of added.split("\n")) {
      if (!entry.startsWith("{")) continue;
      const envelope = JSON.parse(entry) as { total_cost_usd?: number; usage?: Usage };
      costUsd += envelope.total_cost_usd ?? 0;
      tokens += usageTokens(envelope.usage);
    }
  } else {
    for (const match of added.matchAll(/tokens used\s*\n?\s*([\d,]+)/g))
      tokens += Number(match[1]!.replaceAll(",", ""));
  }
  return { route, ms, costUsd, tokens };
};

interface LineLog {
  readonly from: string;
  readonly expect?: "quiet" | "reply";
  readonly route?: "agent" | "people";
  readonly routerMs?: number;
  readonly routerCostUsd?: number;
  readonly routerTokens?: number;
  readonly turn?: AgentTurn;
}

const forgetSession = (cwd: string, session: string) => {
  // The eval's sessions should not crowd the developer's own resume lists.
  if (isClaude(model)) {
    const project = NodePath.join(
      NodeOS.homedir(),
      ".claude",
      "projects",
      cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    NodeFS.rmSync(project, { recursive: true, force: true });
    return;
  }
  const root = NodePath.join(NodeOS.homedir(), ".codex", "sessions");
  for (const day of [0, 1].map((back) => new Date(Date.now() - back * 86_400_000))) {
    const dir = NodePath.join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    if (!NodeFS.existsSync(dir)) continue;
    for (const file of NodeFS.readdirSync(dir)) {
      if (session !== "" && file.endsWith(`${session}.jsonl`)) NodeFS.rmSync(NodePath.join(dir, file));
    }
  }
};

const gotOf = (line: LineLog): "quiet" | "reply" =>
  arm === "router"
    ? line.route === "people"
      ? "quiet"
      : "reply"
    : arm === "tool"
      ? line.turn!.quietTool
        ? "quiet"
        : "reply"
      : line.turn!.reply === QUIET_MARKER_SPIKE
        ? "quiet"
        : "reply";

const runSample = async (fixture: (typeof sharedThreadCases)[number], sample: number) => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shared-thread-quiet-"));
  NodeFS.writeFileSync(
    NodePath.join(cwd, "todos.js"),
    "export function addTodo(list, title) {\n  return [...list, { title, done: false }];\n}\n",
  );
  const log = NodePath.join(cwd, ".router-log");
  let session: string | undefined;
  const lines: Array<LineLog> = [];
  const recent: Array<SharedThreadLineSpike> = [];
  let held: Array<SharedThreadLineSpike> = [];
  try {
    for (const message of fixture.messages) {
      const line = { name: nameOf(message), text: message.text };
      if (arm !== "router") {
        const turn = await agentTurn(cwd, attributed(message, arm), session, arm === "tool");
        session = turn.session;
        lines.push({ from: line.name, ...(message.expect ? { expect: message.expect } : {}), turn });
        recent.push(line, { name: "Agent", text: turn.reply });
        continue;
      }
      const routed = await routeLine(cwd, log, recent, line);
      recent.push(line);
      if (routed.route === "people") {
        held.push(line);
        lines.push({
          from: line.name,
          ...(message.expect ? { expect: message.expect } : {}),
          route: "people",
          routerMs: routed.ms,
          routerCostUsd: routed.costUsd,
          routerTokens: routed.tokens,
        });
        continue;
      }
      const text = `${peopleLinesPromptSpike(held)}${attributed(message, "answer")}`;
      held = [];
      const turn = await agentTurn(cwd, text, session, false);
      session = turn.session;
      recent.push({ name: "Agent", text: turn.reply });
      lines.push({
        from: line.name,
        ...(message.expect ? { expect: message.expect } : {}),
        route: "agent",
        routerMs: routed.ms,
        routerCostUsd: routed.costUsd,
        routerTokens: routed.tokens,
        turn,
      });
    }
  } finally {
    if (session) forgetSession(cwd, session);
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
  const last = lines.at(-1)!;
  const got = gotOf(last);
  return {
    arm,
    model,
    routerModel: arm === "router" ? routerModel : undefined,
    id: fixture.id,
    kind: fixture.kind,
    sample,
    expect: fixture.expect,
    got,
    pass: got === fixture.expect,
    reply: last.turn?.reply ?? "",
    last,
    costUsd: lines.reduce(
      (sum, entry) => sum + (entry.turn?.costUsd ?? 0) + (entry.routerCostUsd ?? 0),
      0,
    ),
    tokens: lines.reduce(
      (sum, entry) => sum + (entry.turn?.tokens ?? 0) + (entry.routerTokens ?? 0),
      0,
    ),
    lines,
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
await routerRuntime.dispose();
NodeFS.rmSync(shimDir, { recursive: true, force: true });
rows.sort((a, b) => a.id.localeCompare(b.id) || a.sample - b.sample);
NodeFS.writeFileSync(NodePath.join(outDir, "results.json"), JSON.stringify(rows, null, 2));
if (failures.length > 0)
  NodeFS.writeFileSync(NodePath.join(outDir, "failures.json"), JSON.stringify(failures, null, 2));

// Per-line economics come from the graded last line: a quiet case's line is a people line.
const mean = (xs: ReadonlyArray<number>) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
const lastCost = (row: Row) => (row.last.turn?.costUsd ?? 0) + (row.last.routerCostUsd ?? 0);
const lastTokens = (row: Row) => (row.last.turn?.tokens ?? 0) + (row.last.routerTokens ?? 0);
const people = rows.filter((row) => row.expect === "quiet");
const asks = rows.filter((row) => row.expect === "reply");
function historyStats() {
  const graded = rows.flatMap((row) =>
    row.lines.slice(0, -1).filter((line) => line.expect !== undefined),
  );
  return {
    historyMisses: graded.filter((line) => line.expect === "reply" && gotOf(line) === "quiet")
      .length,
    historyAsks: graded.filter((line) => line.expect === "reply").length,
    historyUnwanted: graded.filter((line) => line.expect === "quiet" && gotOf(line) === "reply")
      .length,
    historyPeopleLines: graded.filter((line) => line.expect === "quiet").length,
  };
}
const stats = {
  arm,
  model,
  routerModel: arm === "router" ? routerModel : null,
  samples: rows.length,
  errors: failures.length,
  misses: asks.filter((row) => row.got === "quiet").length,
  asks: asks.length,
  unwanted: people.filter((row) => row.got === "reply").length,
  peopleLines: people.length,
  peopleLineCostUsd: mean(people.map(lastCost)),
  peopleLineTokens: mean(people.map(lastTokens)),
  askLineCostUsd: mean(asks.map(lastCost)),
  askLineTokens: mean(asks.map(lastTokens)),
  // The thread is busy only while an agent turn runs; a router runs beside the thread.
  peopleLineBusyMs: mean(people.map((row) => row.last.turn?.ms ?? 0)),
  askLineAddedMs: mean(asks.map((row) => row.last.routerMs ?? 0)),
  askLineTurnMs: mean(asks.map((row) => row.last.turn?.ms ?? 0)),
  // A quiet tool call beside written text: the server would hide the text.
  quietToolWithText: rows.filter((row) => row.last.turn?.quietTool && row.last.turn.reply !== "")
    .length,
  ...historyStats(),
  totalCostUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
  totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
};
NodeFS.writeFileSync(NodePath.join(outDir, "stats.json"), JSON.stringify(stats, null, 2));

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
NodeFS.writeFileSync(
  NodePath.join(outDir, "summary.md"),
  [
    `Arm ${arm}, model ${model}${arm === "router" ? `, router ${routerModel}` : ""}: ${rows.length} samples, ${failures.length} errors, cost $${stats.totalCostUsd.toFixed(4)}, ${stats.totalTokens} tokens`,
    "",
    `Misses ${stats.misses}/${stats.asks}, unwanted replies ${stats.unwanted}/${stats.peopleLines}; history lines: misses ${stats.historyMisses}/${stats.historyAsks}, unwanted ${stats.historyUnwanted}/${stats.historyPeopleLines}`,
    "",
    `| Case | Kind | Expect | Passed |${values.baseline ? " Baseline |" : ""}`,
    `| --- | --- | --- | --- |${values.baseline ? " --- |" : ""}`,
    ...caseRows,
    "",
  ].join("\n"),
);
console.log(NodeFS.readFileSync(NodePath.join(outDir, "summary.md"), "utf8"));
