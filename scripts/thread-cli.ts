#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Reads the token file and optional stdin text synchronously before connecting.

import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import {
  CommandId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import {
  dispatchCommand,
  readShellSnapshot,
  readThreadDetail,
  requireThreadShell,
  ThreadRpcError,
  type ThreadRpcEndpoint,
  waitForThreadShell,
  withThreadRpcClient,
} from "./lib/thread-rpc.ts";

const USAGE = "Usage: vp run thread <projects|threads|create|send|read> [options]";

const HELP = `Drive T3 Code threads over a server's WebSocket RPC.

${USAGE}
       bun scripts/thread-cli.ts <command> [options]

Commands:
  projects                        List projects: id, title, workspace root.
  threads [--project ID]          List active threads: id, status, provider/model, title.
  create --project ID --title T --provider INSTANCE --model M [--runtime MODE]
                                  Create a thread and print its id (MODE: full-access).
  send --thread ID --text TEXT    Start a turn with TEXT ('-' reads stdin).
  read --thread ID [--since ISO] [--wait-idle] [--timeout S]
                                  Print messages at or after --since; --wait-idle blocks
                                  until the turn settles (--timeout default 600).

Options:
  --url URL          Server origin (default: $T3_URL, else http://127.0.0.1:3773).
  --token-file PATH  Bearer token file; otherwise $T3_TOKEN.
  --json             Emit one JSON document on stdout.
  -h, --help         Show this help.

Token: on the server host, 't3 auth session issue --label NAME --json' prints
sessionId and token; 't3 auth session revoke SESSION_ID' revokes it.

Settled: no running turn, or the thread awaits an approval or user input.
With --since, --wait-idle also needs a turn requested at or after that time.

Output: tab-separated lines or JSON on stdout; errors on stderr; never the token.
Writes: create and send dispatch orchestration commands; nothing local.
Exits: 0 ok, 1 connection/server failure, 2 invalid usage, 3 --wait-idle timed out.
`;

const DEFAULT_URL = "http://127.0.0.1:3773";
const DEFAULT_WAIT_SECONDS = 600;
const CONNECTION_VALUES = ["--url", "--token-file"] as const;

type Connection = { readonly url: string; readonly tokenFile: string | undefined };

export type ThreadCliArguments =
  | { readonly kind: "help" }
  | (Connection & { readonly json: boolean } & (
        | { readonly kind: "projects" }
        | { readonly kind: "threads"; readonly projectId: string | undefined }
        | {
            readonly kind: "create";
            readonly projectId: string;
            readonly title: string;
            readonly provider: string;
            readonly model: string;
            readonly runtimeMode: RuntimeMode;
          }
        | { readonly kind: "send"; readonly threadId: string; readonly text: string }
        | {
            readonly kind: "read";
            readonly threadId: string;
            readonly since: string | undefined;
            readonly waitIdle: boolean;
            readonly timeoutSeconds: number;
          }
      ));

const COMMAND_VALUES = {
  projects: [],
  threads: ["--project"],
  create: ["--project", "--title", "--provider", "--model", "--runtime"],
  send: ["--thread", "--text"],
  read: ["--thread", "--since", "--timeout"],
} as const;

type CommandName = keyof typeof COMMAND_VALUES;

const isCommandName = (value: string | undefined): value is CommandName =>
  value !== undefined && Object.hasOwn(COMMAND_VALUES, value);

const isRuntimeMode = (value: string): value is RuntimeMode =>
  (RuntimeMode.literals as ReadonlyArray<string>).includes(value);

export function parseThreadCliArguments(
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = {},
): ThreadCliArguments {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [command, ...rest] = argv;
  if (!isCommandName(command)) {
    throw new UsageError(command === undefined ? "missing command" : `unknown command: ${command}`);
  }
  const parsed = parseArgs(rest, {
    values: [...CONNECTION_VALUES, ...COMMAND_VALUES[command]],
    flags: command === "read" ? ["--json", "--wait-idle"] : ["--json"],
  });
  const value = (name: string) => parsed.values.get(name);
  const required = (name: string) => {
    const found = value(name);
    if (found === undefined) throw new UsageError(`${command} requires ${name}`);
    return found;
  };
  const base = {
    url: parseUrl(value("--url") ?? env.T3_URL ?? DEFAULT_URL),
    tokenFile: value("--token-file"),
    json: parsed.flags.has("--json"),
  };

  switch (command) {
    case "projects":
      return { ...base, kind: "projects" };
    case "threads":
      return { ...base, kind: "threads", projectId: value("--project") };
    case "create": {
      const runtimeMode = value("--runtime") ?? "full-access";
      if (!isRuntimeMode(runtimeMode)) {
        throw new UsageError(
          `--runtime must be one of ${RuntimeMode.literals.join(", ")}; received: ${runtimeMode}`,
        );
      }
      return {
        ...base,
        kind: "create",
        projectId: required("--project"),
        title: required("--title"),
        provider: required("--provider"),
        model: required("--model"),
        runtimeMode,
      };
    }
    case "send":
      return { ...base, kind: "send", threadId: required("--thread"), text: required("--text") };
    case "read": {
      const waitIdle = parsed.flags.has("--wait-idle");
      const timeout = value("--timeout");
      if (timeout !== undefined && !waitIdle) throw new UsageError("--timeout needs --wait-idle");
      const since = value("--since");
      return {
        ...base,
        kind: "read",
        threadId: required("--thread"),
        since: since === undefined ? undefined : parseSince(since),
        waitIdle,
        timeoutSeconds: timeout === undefined ? DEFAULT_WAIT_SECONDS : parseTimeout(timeout),
      };
    }
  }
}

function parseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--url must be an http(s) origin; received: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`--url must be an http(s) origin; received: ${raw}`);
  }
  return url.origin;
}

function parseSince(raw: string): string {
  const parsed = DateTime.make(raw);
  if (parsed._tag === "None") {
    throw new UsageError(`--since must be an ISO time; received: ${raw}`);
  }
  return DateTime.formatIso(parsed.value);
}

function parseTimeout(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--timeout must be a positive number of seconds; received: ${raw}`);
  }
  return seconds;
}

type ThreadActivity = Pick<
  OrchestrationThreadShell,
  "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
>;

/** One word for where a thread stands: `running`, `awaiting-*`, or the session status. */
export function threadStatus(thread: ThreadActivity): string {
  if (thread.hasPendingApprovals) return "awaiting-approval";
  if (thread.hasPendingUserInput) return "awaiting-input";
  const sessionStatus = thread.session?.status;
  if (
    sessionStatus === "starting" ||
    sessionStatus === "running" ||
    thread.latestTurn?.state === "running"
  ) {
    return "running";
  }
  return sessionStatus ?? "idle";
}

/**
 * A turn has settled once nothing runs or it blocks on a human. With `since`, a turn requested at
 * or after it must exist, so a read right after `send` does not return on the previous idle state;
 * a session error after `since` also settles, since a failed start never records a turn.
 */
export function isThreadSettled(thread: ThreadActivity, since?: string): boolean {
  const status = threadStatus(thread);
  if (status === "running") return false;
  if (since === undefined || status.startsWith("awaiting-")) return true;
  const sinceMillis = Date.parse(since);
  const requestedAt = thread.latestTurn ? Date.parse(thread.latestTurn.requestedAt) : Number.NaN;
  if (requestedAt >= sinceMillis) return true;
  return thread.session?.status === "error" && Date.parse(thread.session.updatedAt) >= sinceMillis;
}

export function selectMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
  since: string | undefined,
): ReadonlyArray<OrchestrationMessage> {
  const sinceMillis = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
  // Reasoning is opted into on the wire so it stays out of `system`; it is not conversation.
  return messages.filter(
    (message) => message.role !== "reasoning" && Date.parse(message.createdAt) >= sinceMillis,
  );
}

const projectRow = (project: OrchestrationProjectShell) => ({
  id: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
});

const threadRow = (thread: OrchestrationThreadShell) => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  provider: thread.modelSelection.instanceId,
  model: thread.modelSelection.model,
  runtimeMode: thread.runtimeMode,
  status: threadStatus(thread),
  updatedAt: thread.updatedAt,
});

const messageRow = (message: OrchestrationMessage) => ({
  id: message.id,
  role: message.role,
  text: message.text,
  createdAt: message.createdAt,
  streaming: message.streaming,
});

export function formatMessages(messages: ReadonlyArray<OrchestrationMessage>): string {
  return messages
    .map(
      (message) =>
        `--- ${message.role} ${message.createdAt}${message.streaming ? " (streaming)" : ""}\n` +
        `${message.text}\n`,
    )
    .join("\n");
}

const lines = (rows: ReadonlyArray<ReadonlyArray<string>>) =>
  rows.map((row) => `${row.join("\t")}\n`).join("");

type RunResult = { readonly stdout: string; readonly exitCode: 0 | 3; readonly stderr?: string };

const newUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError((cause) => new ThreadRpcError({ detail: `uuid generation failed: ${cause}` })),
);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runCommand = (
  args: Exclude<ThreadCliArguments, { kind: "help" }>,
  endpoint: ThreadRpcEndpoint,
  text: string,
) =>
  withThreadRpcClient(endpoint, (client) =>
    Effect.gen(function* () {
      const shell = yield* readShellSnapshot(client);
      const emit = (json: unknown, human: string): RunResult => ({
        stdout: args.json ? `${JSON.stringify(json, null, 2)}\n` : human,
        exitCode: 0,
      });
      switch (args.kind) {
        case "projects": {
          const projects = shell.projects.map(projectRow);
          return emit(
            { projects },
            lines(projects.map((row) => [row.id, row.title, row.workspaceRoot])),
          );
        }
        case "threads": {
          const threads = shell.threads
            .filter((thread) => args.projectId === undefined || thread.projectId === args.projectId)
            .map(threadRow);
          return emit(
            { threads },
            lines(
              threads.map((row) => [row.id, row.status, `${row.provider}/${row.model}`, row.title]),
            ),
          );
        }
        case "create": {
          if (!shell.projects.some((project) => project.id === args.projectId)) {
            return yield* new ThreadRpcError({ detail: `no active project ${args.projectId}` });
          }
          const threadId = ThreadId.make(yield* newUuid);
          const createdAt = yield* nowIso;
          const result = yield* dispatchCommand(client, {
            type: "thread.create",
            commandId: CommandId.make(yield* newUuid),
            threadId,
            projectId: ProjectId.make(args.projectId),
            title: args.title,
            modelSelection: {
              instanceId: ProviderInstanceId.make(args.provider),
              model: args.model,
            },
            runtimeMode: args.runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          });
          return emit({ threadId, createdAt, sequence: result.sequence }, `${threadId}\n`);
        }
        case "send": {
          const thread = yield* requireThreadShell(shell, args.threadId);
          const messageId = MessageId.make(yield* newUuid);
          const createdAt = yield* nowIso;
          // Carry the thread's own selection and modes, as the web composer does; an omitted
          // runtimeMode would decode to the full-access default.
          const result = yield* dispatchCommand(client, {
            type: "thread.turn.start",
            commandId: CommandId.make(yield* newUuid),
            threadId: thread.id,
            message: { messageId, role: "user", text, attachments: [] },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt,
          });
          return emit(
            { threadId: thread.id, messageId, createdAt, sequence: result.sequence },
            `${messageId}\t${createdAt}\n`,
          );
        }
        case "read": {
          let thread = yield* requireThreadShell(shell, args.threadId);
          let settled: boolean | undefined;
          if (args.waitIdle) {
            const waited = yield* waitForThreadShell(
              client,
              thread.id,
              (candidate) => isThreadSettled(candidate, args.since),
              Duration.seconds(args.timeoutSeconds),
            );
            settled = waited.settled;
            thread = waited.latest ?? thread;
          }
          const detail = yield* readThreadDetail(client, thread.id);
          const messages = selectMessages(detail.messages, args.since);
          const status = threadStatus(thread);
          const result = emit(
            {
              threadId: thread.id,
              title: detail.title,
              status,
              ...(settled === undefined ? {} : { settled }),
              messages: messages.map(messageRow),
            },
            formatMessages(messages),
          );
          return settled === false
            ? {
                ...result,
                exitCode: 3,
                stderr: `timed out after ${args.timeoutSeconds}s; thread status: ${status}\n`,
              }
            : result;
        }
      }
    }),
  );

export type ThreadCliDependencies = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly readStdin: () => string;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
};

const defaultDependencies: ThreadCliDependencies = {
  env: process.env,
  readFile: (path) => NodeFS.readFileSync(path, "utf8"),
  readStdin: () => NodeFS.readFileSync(0, "utf8"),
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

function describeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error) {
    const tag = (error as { readonly _tag?: unknown })._tag;
    return typeof tag === "string" && !error.message.includes(tag)
      ? `${tag}: ${error.message}`
      : error.message;
  }
  return String(error);
}

export async function runThreadCli(
  argv: ReadonlyArray<string>,
  dependencies: ThreadCliDependencies = defaultDependencies,
): Promise<number> {
  let args: ThreadCliArguments;
  try {
    args = parseThreadCliArguments(argv, dependencies.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`error: ${message}\n${USAGE}\n`);
    return 2;
  }
  if (args.kind === "help") {
    dependencies.writeStdout(HELP);
    return 0;
  }

  let bearerToken: string;
  let text = "";
  try {
    bearerToken = (
      args.tokenFile === undefined
        ? (dependencies.env.T3_TOKEN ?? "")
        : dependencies.readFile(args.tokenFile)
    ).trim();
    if (args.kind === "send") text = args.text === "-" ? dependencies.readStdin() : args.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`error: ${message}\n`);
    return 1;
  }
  if (bearerToken.length === 0) {
    dependencies.writeStderr(`error: no token; pass --token-file or set T3_TOKEN\n${USAGE}\n`);
    return 2;
  }
  if (args.kind === "send" && text.trim().length === 0) {
    dependencies.writeStderr(`error: --text is empty\n${USAGE}\n`);
    return 2;
  }

  const exit = await Effect.runPromiseExit(
    runCommand(args, { httpBaseUrl: args.url, bearerToken }, text).pipe(
      Effect.provide(NodeCrypto.layer),
    ),
  );
  if (Exit.isFailure(exit)) {
    dependencies.writeStderr(`error: ${describeFailure(exit.cause)}\n`);
    return 1;
  }
  dependencies.writeStdout(exit.value.stdout);
  if (exit.value.stderr) dependencies.writeStderr(exit.value.stderr);
  return exit.value.exitCode;
}

if (import.meta.main) {
  process.exitCode = await runThreadCli(process.argv.slice(2));
}
