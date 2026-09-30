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
import * as SchemaAST from "effect/SchemaAST";
import { beforeAll, describe, expect, it } from "vite-plus/test";

type Codec = Schema.Codec<unknown, unknown>;

/** The contract exports these cases read, typed loosely so neither tree joins this program. */
interface Contracts {
  readonly OrchestrationShellStreamItem: Codec;
  readonly OrchestrationThreadStreamItem: Codec;
  readonly ExecutionEnvironmentDescriptor: Codec;
  readonly OrchestrationEvent: Codec;
  readonly OrchestrationEventType: Codec & { readonly literals: ReadonlyArray<string> };
  readonly ServerConfig: Codec;
  readonly ServerConfigStreamEvent: Codec;
  readonly VcsStatusStreamEvent: Codec;
  readonly GitPreparePullRequestThreadResult: Codec;
}

/** Every schema an upstream client decodes from a fork server, by export name. */
const wireSchemas = [
  "ServerConfig",
  "ServerConfigStreamEvent",
  "OrchestrationShellStreamItem",
  "OrchestrationThreadStreamItem",
  "ExecutionEnvironmentDescriptor",
  "VcsStatusStreamEvent",
  "GitPreparePullRequestThreadResult",
] as const;

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

/**
 * Slots the schema admits but the server never sends. The thread stream
 * forwards only thread-detail events (`isThreadDetailEvent` in
 * `apps/server/src/ws.ts`), and the shell stream turns project events into a
 * `project-upserted` read model.
 */
const sentNever = new Set([
  '$<event>.event<project.meta-updated>.payload.defaultThreadEnvMode: "worktrunk"',
]);

/** Literal values a wire slot admits, keyed by path; `open` when it also admits any string. */
type LiteralSlots = Map<string, { literals: Set<unknown>; open: boolean }>;

const collectLiterals = (
  ast: SchemaAST.AST,
  path = "$",
  slots: LiteralSlots = new Map(),
  suspends = new WeakSet<SchemaAST.AST>(),
): LiteralSlots => {
  const slot = () => {
    let entry = slots.get(path);
    if (!entry) slots.set(path, (entry = { literals: new Set(), open: false }));
    return entry;
  };
  const walk = (next: SchemaAST.AST, nextPath: string) =>
    collectLiterals(next, nextPath, slots, suspends);
  // A suspend is a recursive schema: walk its body once, at its first path.
  if (SchemaAST.isSuspend(ast)) {
    if (!suspends.has(ast)) {
      suspends.add(ast);
      walk(ast.thunk(), path);
    }
  } else if (SchemaAST.isLiteral(ast)) slot().literals.add(ast.literal);
  else if (SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)) slot().open = true;
  else if (SchemaAST.isUnion(ast)) for (const type of ast.types) walk(type, path);
  else if (SchemaAST.isObjects(ast)) {
    // A union member keys its paths by its tag, so members never pool literals.
    const tag = ast.propertySignatures.find(
      (property) =>
        ["type", "kind", "_tag"].includes(String(property.name)) &&
        SchemaAST.isLiteral(property.type),
    );
    const base =
      tag && SchemaAST.isLiteral(tag.type) ? `${path}<${String(tag.type.literal)}>` : path;
    for (const property of ast.propertySignatures) {
      walk(property.type, `${base}.${String(property.name)}`);
    }
    for (const index of ast.indexSignatures) walk(index.type, `${base}[*]`);
  } else if (SchemaAST.isArrays(ast)) {
    for (const element of [...ast.elements, ...ast.rest]) walk(element, `${path}[]`);
  }
  return slots;
};

/**
 * Fork literals in a slot upstream also reads that upstream would not admit.
 * Walks the wire form and the decoded form: a lenient upstream slot can accept
 * any wire value yet decode an unknown one to nothing.
 */
const forkOnlyLiterals = (forkSchema: Codec, upstreamSchema: Codec) =>
  [SchemaAST.toEncoded, SchemaAST.toType].flatMap((side) => {
    const upstreamSlots = collectLiterals(side(upstreamSchema.ast));
    return [...collectLiterals(side(forkSchema.ast))].flatMap(([path, forkSlot]) => {
      const upstreamSlot = upstreamSlots.get(path);
      if (!upstreamSlot || upstreamSlot.open || upstreamSlot.literals.size === 0) return [];
      return [...forkSlot.literals]
        .filter((literal) => !upstreamSlot.literals.has(literal))
        .map((literal) => `${path}: ${JSON.stringify(literal)}`);
    });
  });

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
const checkoutMove = {
  requestId: "command-compat",
  source: { repositoryRoot: "/repo", checkoutRoot: "/repo", revision: "abc123", branch: "main" },
  requestedPath: "/repo-worktree",
  destination: null,
  expectedCheckoutRoot: "/repo",
  status: "queued",
  completedSteps: [],
  effectiveProvider: null,
  requestedAt: now,
  updatedAt: now,
};
const project = {
  id: "project-compat",
  title: "Compat project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: "worktree",
  defaultThreadEnvModeFork: "worktrunk",
  scripts: [],
  createdAt: now,
  updatedAt: now,
};
/** Fork settings keys, with the Worktrunk mode standing behind its upstream wire value. */
const forkSettings = {
  defaultThreadEnvMode: "worktree",
  defaultThreadEnvModeFork: "worktrunk",
  terminalSessionMode: "zmux",
  githubIssueHandoffPromptTemplate: "Work on #{{number}}",
  followExternalWorkspaceSymlinks: true,
  projectSettingsOverrides: {
    [project.id]: { defaultThreadEnvMode: "worktree", defaultThreadEnvModeFork: "worktrunk" },
  },
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
  checkoutMove,
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
        snapshot: {
          snapshotSequence: 1,
          projects: [project],
          threads: [threadShell],
          updatedAt: now,
        },
      },
      { kind: "project-upserted", sequence: 2, project },
      { kind: "thread-upserted", sequence: 3, thread: threadShell },
    ];
    for (const item of items) {
      const decoded = acrossTheWire(
        fork.OrchestrationShellStreamItem,
        upstream.OrchestrationShellStreamItem,
        item,
      );
      const wire = JSON.stringify(decoded);
      for (const key of ["issues", "checkoutMove", "Fork", "worktrunk"]) {
        expect(wire).not.toContain(key);
      }
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

  it("reads fork settings through their upstream slots, Worktrunk as a worktree", () => {
    const decoded = acrossTheWire(fork.ServerConfigStreamEvent, upstream.ServerConfigStreamEvent, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings: forkSettings },
    });
    expect(decoded).toMatchObject({
      payload: {
        settings: {
          defaultThreadEnvMode: "worktree",
          projectSettingsOverrides: { [project.id]: { defaultThreadEnvMode: "worktree" } },
        },
      },
    });
    const wire = JSON.stringify(decoded);
    for (const key of ["Fork", "worktrunk", "terminalSessionMode", "githubIssueHandoff"]) {
      expect(wire).not.toContain(key);
    }
  });

  it("decodes a VCS status from a Worktrunk worktree", () => {
    const local = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature",
      hasWorkingTreeChanges: false,
      worktrunk: true,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };
    const decoded = acrossTheWire(fork.VcsStatusStreamEvent, upstream.VcsStatusStreamEvent, {
      _tag: "localUpdated",
      local,
    });
    expect(decoded).toMatchObject({ _tag: "localUpdated", local: { refName: "feature" } });
    expect(JSON.stringify(decoded)).not.toContain("worktrunk");
  });

  it("decodes a pull request thread result that carries a zmux notice", () => {
    const decoded = acrossTheWire(
      fork.GitPreparePullRequestThreadResult,
      upstream.GitPreparePullRequestThreadResult,
      {
        pullRequest: {
          number: 42,
          title: "Compat PR",
          url: "https://github.com/acme/web/pull/42",
          baseBranch: "main",
          headBranch: "feature",
          state: "open",
        },
        branch: "feature",
        worktreePath: "/repo-feature",
        zmuxSessionNotice: { summary: "zmux unavailable", detail: "No zmux on PATH" },
      },
    );
    expect(decoded).toMatchObject({ branch: "feature", worktreePath: "/repo-feature" });
    expect(JSON.stringify(decoded)).not.toContain("zmux");
  });

  // Durable guard: a fork value in a slot upstream decodes (the Worktrunk env
  // mode once was) fails here. Fork-only keys pass, since upstream drops them.
  it("admits no fork-only literal in a slot an upstream client decodes", () => {
    for (const name of wireSchemas) {
      const leaks = forkOnlyLiterals(fork[name], upstream[name]).filter(
        (leak) => !sentNever.has(leak),
      );
      expect(leaks, name).toEqual([]);
    }
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
