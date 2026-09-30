// @effect-diagnostics nodeBuiltinImport:off - Extracts upstream sources with git before any Effect runtime exists.
// The fork ships no mobile build: users run the upstream app against a fork
// server (RSI-Software/t3code-hyprws#1435). These cases encode fork payloads
// with the fork contracts and decode them with the contracts at the upstream
// base, `git merge-base HEAD upstream/main`, extracted into a gitignored cache.
// The server half of the event rule lives in
// `apps/server/src/ws.threadIssues.fork.suite.ts`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Schema from "effect/Schema";
import { beforeAll, describe, expect, it } from "vite-plus/test";

type Codec = Schema.Codec<unknown, unknown>;

/** The contract exports these cases read, typed loosely so neither tree joins this program. */
interface Contracts {
  readonly OrchestrationShellStreamItem: Codec;
  readonly OrchestrationThreadStreamItem: Codec;
  readonly ExecutionEnvironmentDescriptor: Codec;
  readonly OrchestrationEvent: Codec;
  readonly OrchestrationEventType: Codec & { readonly literals: ReadonlyArray<string> };
}

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const contractsEntry = "packages/contracts/src/index.ts";

const git = (args: ReadonlyArray<string>, what: string) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `upstream client compatibility needs ${what}; run \`git fetch upstream main\` first.\n` +
        `git ${args.join(" ")}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
};

/** Extracts upstream contracts once per base; `effect` resolves beside the fork contracts. */
const loadUpstreamContracts = async () => {
  git(["rev-parse", "--verify", "upstream/main^{commit}"], "the upstream/main ref");
  const base = git(["merge-base", "HEAD", "upstream/main"], "a merge base with upstream/main");
  // Under the contracts package so `effect` resolves to the fork contracts' own copy.
  const dir = NodePath.join(repoRoot, "packages/contracts/node_modules/.cache/upstream", base);
  if (!NodeFS.existsSync(NodePath.join(dir, contractsEntry))) {
    const staging = `${dir}.partial-${process.pid}`;
    NodeFS.mkdirSync(staging, { recursive: true });
    const archive = NodeChildProcess.spawnSync(
      "sh",
      ["-c", `git archive ${base} packages/contracts/src | tar -x -C "${staging}"`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (archive.status !== 0) {
      throw new Error(`could not extract upstream contracts at ${base}: ${archive.stderr}`);
    }
    NodeFS.renameSync(staging, dir);
  }
  return (await import(NodePath.join(dir, contractsEntry))) as Contracts;
};

const loadForkContracts = async () =>
  (await import(NodePath.join(repoRoot, contractsEntry))) as Contracts;

/** Fork encode, JSON wire, upstream decode: the path an upstream client reads. */
const acrossTheWire = (fork: Codec, upstream: Codec, value: unknown) => {
  const encoded = Schema.encodeUnknownSync(Schema.toCodecJson(fork))(
    Schema.decodeUnknownSync(fork)(value),
  );
  return Schema.decodeUnknownSync(Schema.toCodecJson(upstream))(
    JSON.parse(JSON.stringify(encoded)),
  );
};

const now = "2026-01-01T00:00:00.000Z";
const issue = {
  host: "github.com",
  repository: "acme/web",
  number: 7,
  url: "https://github.com/acme/web/issues/7",
  source: "manual",
  linkedAt: now,
  snapshot: { title: "Crash on open", state: "open", syncedAt: now },
};
const threadCore = {
  id: "thread-compat",
  projectId: "project-compat",
  title: "Compat thread",
  modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  issues: [issue],
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
};
const threadShell = {
  ...threadCore,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const threadDetail = {
  ...threadCore,
  messages: [],
  activities: [],
  proposedPlans: [],
  checkpoints: [],
  deletedAt: null,
};

let fork: Contracts;
let upstream: Contracts;

beforeAll(async () => {
  [fork, upstream] = await Promise.all([loadForkContracts(), loadUpstreamContracts()]);
}, 60_000);

describe("an upstream client reading a fork server", () => {
  it("decodes shell items and thread snapshots that carry issues", () => {
    const items = [
      {
        kind: "snapshot",
        snapshot: { snapshotSequence: 1, projects: [], threads: [threadShell], updatedAt: now },
      },
      { kind: "thread-upserted", sequence: 2, thread: threadShell },
    ];
    for (const item of items) {
      const decoded = acrossTheWire(
        fork.OrchestrationShellStreamItem,
        upstream.OrchestrationShellStreamItem,
        item,
      );
      expect(JSON.stringify(decoded)).not.toContain("issues");
    }
    const detail = acrossTheWire(
      fork.OrchestrationThreadStreamItem,
      upstream.OrchestrationThreadStreamItem,
      { kind: "snapshot", snapshot: { snapshotSequence: 1, thread: threadDetail } },
    );
    expect(detail).toMatchObject({ kind: "snapshot", snapshot: { thread: { id: threadCore.id } } });
  });

  it("decodes an environment descriptor that advertises fork capabilities", () => {
    const decoded = acrossTheWire(
      fork.ExecutionEnvironmentDescriptor,
      upstream.ExecutionEnvironmentDescriptor,
      {
        environmentId: "environment-compat",
        label: "Fork server",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-compat",
        capabilities: {
          repositoryIdentity: true,
          githubIssues: true,
          threadIssues: true,
          githubIssueStateChange: true,
        },
      },
    );
    expect(decoded).toMatchObject({ capabilities: { repositoryIdentity: true } });
    expect(JSON.stringify(decoded)).not.toContain("githubIssues");
  });

  it("rejects every fork-only event type, so the server must never send one", () => {
    const upstreamTypes = new Set(upstream.OrchestrationEventType.literals);
    const forkOnly = fork.OrchestrationEventType.literals.filter(
      (type) => !upstreamTypes.has(type),
    );
    expect(forkOnly).toEqual(expect.arrayContaining(["thread.issue-linked"]));
    const linked = {
      sequence: 2,
      eventId: "event-compat",
      aggregateKind: "thread",
      aggregateId: threadCore.id,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.issue-linked",
      payload: { threadId: threadCore.id, link: issue, updatedAt: now },
    };
    expect(() =>
      acrossTheWire(fork.OrchestrationEvent, upstream.OrchestrationEvent, linked),
    ).toThrow();
    const decodeType = Schema.decodeUnknownExit(upstream.OrchestrationEventType);
    for (const type of forkOnly) expect(decodeType(type)._tag, type).toBe("Failure");
  });
});
