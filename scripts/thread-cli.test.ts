import { MessageId, ThreadId, TurnId, type OrchestrationMessage } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import {
  isThreadSettled,
  parseThreadCliArguments,
  runThreadCli,
  selectMessages,
  type ThreadCliDependencies,
  threadStatus,
} from "./thread-cli.ts";

type Activity = Parameters<typeof isThreadSettled>[0];

const idle: Activity = {
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

const turn = (state: "running" | "completed", requestedAt: string): Activity["latestTurn"] => ({
  turnId: TurnId.make("turn-1"),
  state,
  requestedAt,
  startedAt: requestedAt,
  completedAt: state === "completed" ? requestedAt : null,
  assistantMessageId: null,
});

const session = (status: "running" | "ready" | "error", updatedAt: string) => ({
  threadId: ThreadId.make("thread-1"),
  status,
  providerName: "claude",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: status === "error" ? "boom" : null,
  updatedAt,
});

const message = (role: OrchestrationMessage["role"], createdAt: string): OrchestrationMessage => ({
  id: MessageId.make(`${role}-${createdAt}`),
  role,
  text: role,
  turnId: null,
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});

it("parses commands with env and default connection", () => {
  assert.deepStrictEqual(parseThreadCliArguments(["projects"]), {
    kind: "projects",
    url: "http://127.0.0.1:3773",
    tokenFile: undefined,
    json: false,
  });
  assert.deepStrictEqual(
    parseThreadCliArguments(
      [
        "read",
        "--thread",
        "t1",
        "--since",
        "2026-01-01T00:00:00Z",
        "--wait-idle",
        "--timeout",
        "5",
      ],
      { T3_URL: "http://host:3773/ignored" },
    ),
    {
      kind: "read",
      url: "http://host:3773",
      tokenFile: undefined,
      json: false,
      threadId: "t1",
      since: "2026-01-01T00:00:00.000Z",
      waitIdle: true,
      timeoutSeconds: 5,
    },
  );
  const created = parseThreadCliArguments([
    "create",
    ...["--project", "p", "--title", "T", "--provider", "claude", "--model", "m"],
  ]);
  assert.strictEqual(created.kind === "create" && created.runtimeMode, "full-access");
});

it("rejects malformed arguments", () => {
  assert.throws(() => parseThreadCliArguments([]), /missing command/u);
  assert.throws(() => parseThreadCliArguments(["wat"]), /unknown command/u);
  assert.throws(() => parseThreadCliArguments(["projects", "--wat"]), /unknown argument/u);
  assert.throws(() => parseThreadCliArguments(["send", "--thread", "t"]), /requires --text/u);
  assert.throws(
    () => parseThreadCliArguments(["read", "--thread", "t", "--timeout", "5"]),
    /--wait-idle/u,
  );
  assert.throws(
    () => parseThreadCliArguments(["read", "--thread", "t", "--since", "soon"]),
    /ISO/u,
  );
  assert.throws(() => parseThreadCliArguments(["projects", "--url", "ftp://x"]), /http\(s\)/u);
  assert.throws(
    () =>
      parseThreadCliArguments([
        "create",
        ...["--project", "p", "--title", "T"],
        ...["--provider", "c", "--model", "m", "--runtime", "yolo"],
      ]),
    /--runtime/u,
  );
});

it("derives status and settlement", () => {
  const since = "2026-01-01T00:00:10.000Z";
  assert.strictEqual(threadStatus(idle), "idle");
  assert.strictEqual(threadStatus({ ...idle, hasPendingApprovals: true }), "awaiting-approval");
  const running = { ...idle, latestTurn: turn("running", since) };
  assert.strictEqual(threadStatus(running), "running");
  assert.isFalse(isThreadSettled(running));
  assert.isTrue(isThreadSettled(idle));
  // A read right after send must not return on the previous turn's idle state.
  assert.isFalse(
    isThreadSettled({ ...idle, latestTurn: turn("completed", "2026-01-01T00:00:00.000Z") }, since),
  );
  assert.isTrue(isThreadSettled({ ...idle, latestTurn: turn("completed", since) }, since));
  assert.isTrue(isThreadSettled({ ...idle, session: session("error", since) }, since));
  assert.isTrue(isThreadSettled({ ...idle, hasPendingUserInput: true }, since));
});

it("drops reasoning and messages before --since", () => {
  const messages = [
    message("user", "2026-01-01T00:00:00.000Z"),
    message("assistant", "2026-01-01T00:00:20.000Z"),
    message("reasoning", "2026-01-01T00:00:20.000Z"),
  ];
  assert.deepStrictEqual(
    selectMessages(messages, undefined).map((m) => m.role),
    ["user", "assistant"],
  );
  assert.deepStrictEqual(
    selectMessages(messages, "2026-01-01T00:00:10.000Z").map((m) => m.role),
    ["assistant"],
  );
});

const capture = (env: ThreadCliDependencies["env"] = {}) => {
  const out = { stdout: "", stderr: "" };
  const deps: ThreadCliDependencies = {
    env,
    readFile: () => "",
    readStdin: () => "",
    writeStdout: (value) => {
      out.stdout += value;
    },
    writeStderr: (value) => {
      out.stderr += value;
    },
  };
  return { out, deps };
};

it("exits 0 for help and 2 for usage errors before connecting", async () => {
  const help = capture();
  assert.strictEqual(await runThreadCli(["--help"], help.deps), 0);
  assert.match(help.out.stdout, /Exits: 0 ok/u);
  assert.isAtMost(help.out.stdout.split("\n").length, 40);

  const unknown = capture();
  assert.strictEqual(await runThreadCli(["projects", "--wat"], unknown.deps), 2);
  assert.match(unknown.out.stderr, /Usage:/u);

  const tokenless = capture();
  assert.strictEqual(await runThreadCli(["projects"], tokenless.deps), 2);
  assert.match(tokenless.out.stderr, /no token/u);
});
