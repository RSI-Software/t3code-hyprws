// @effect-diagnostics nodeBuiltinImport:off - Extracts upstream sources with git before any Effect runtime exists.
// The fork ships no mobile build: users run the upstream app against a fork
// server (RSI-Software/t3code-hyprws#1435). These cases encode fork payloads
// with the fork contracts and decode them with the contracts at the upstream
// base, `git merge-base HEAD upstream/main`, extracted into a gitignored cache.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { beforeAll, describe, expect, it } from "vite-plus/test";

type Codec = Schema.Codec<unknown, unknown>;
type DomainEventUnion = Codec & {
  readonly members: ReadonlyArray<{
    readonly fields: {
      readonly type: { readonly literal?: string; readonly literals?: ReadonlyArray<string> };
    };
  }>;
};

/** The contract exports these cases read, typed loosely so neither tree joins this program. */
interface Contracts {
  readonly OrchestrationV2ShellStreamItem: Codec;
  readonly OrchestrationV2ArchivedShellStreamItem: Codec;
  readonly OrchestrationV2ThreadStreamItem: Codec;
  readonly OrchestrationV2ShellSnapshot: Codec;
  readonly OrchestrationV2ThreadDetailSnapshot: Codec;
  readonly OrchestrationV2ThreadBoundedSnapshot: Codec;
  readonly OrchestrationV2ThreadHistoryPage: Codec;
  readonly OrchestrationV2DomainEvent: DomainEventUnion;
  readonly ExecutionEnvironmentDescriptor: Codec;
  readonly EnvironmentInternalError: Codec;
  readonly ProjectSnapshot: Codec;
  readonly PullRequestDiffResult: Codec;
  readonly ServerConfig: Codec;
  readonly ServerConfigStreamEvent: Codec;
  readonly VcsStatusStreamEvent: Codec;
  readonly GitPreparePullRequestThreadResult: Codec;
  readonly THREAD_ISSUE_EVENT_TYPES_FORK: ReadonlyArray<string>;
}

/**
 * Every schema an upstream client decodes from a fork server, by export name:
 * the WebSocket streams plus the HTTP snapshot routes V2 serves beside them
 * (`EnvironmentOrchestrationHttpApi` in `packages/contracts/src/environmentHttp.ts`).
 */
const wireSchemas = [
  "ServerConfig",
  "ServerConfigStreamEvent",
  "OrchestrationV2ShellStreamItem",
  "OrchestrationV2ArchivedShellStreamItem",
  "OrchestrationV2ThreadStreamItem",
  "OrchestrationV2ShellSnapshot",
  "OrchestrationV2ThreadDetailSnapshot",
  "OrchestrationV2ThreadBoundedSnapshot",
  "OrchestrationV2ThreadHistoryPage",
  "ExecutionEnvironmentDescriptor",
  "EnvironmentInternalError",
  "ProjectSnapshot",
  "PullRequestDiffResult",
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

/**
 * Fork encode, JSON wire, upstream decode: the path an upstream client reads.
 * Fixtures are JSON, so the fork codec first decodes them to its own values.
 */
const acrossTheWire = (fork: Codec, upstream: Codec, json: unknown) => {
  const forkJson = Schema.toCodecJson(fork);
  const encoded = Schema.encodeUnknownSync(forkJson)(Schema.decodeUnknownSync(forkJson)(json));
  return Schema.decodeUnknownSync(Schema.toCodecJson(upstream))(
    JSON.parse(JSON.stringify(encoded)),
  );
};

/**
 * Slots the schema admits but the server never sends to an upstream client.
 * The fork's internal error reason belongs to the fork-only
 * `generateThreadGroupTitle` route, which an upstream client never calls.
 */
const sentNever = new Set([
  '$<EnvironmentInternalError>.reason: "thread_group_title_generation_failed"',
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

const tagFields = ["type", "kind", "_tag"];

/** Union member tags per union path and tag field, read from `collectLiterals` keys. */
const unionTags = (slots: LiteralSlots) => {
  const unions = new Map<string, Set<string>>();
  for (const [path, slot] of slots) {
    const field = tagFields.find((name) => path.endsWith(`>.${name}`));
    if (!field) continue;
    const member = path.slice(0, -field.length - 1);
    const open = member.lastIndexOf("<");
    const tag = member.slice(open + 1, -1);
    if (!slot.literals.has(tag)) continue;
    const union = `${member.slice(0, open)}.${field}`;
    let tags = unions.get(union);
    if (!tags) unions.set(union, (tags = new Set()));
    tags.add(tag);
  }
  return unions;
};

/**
 * Fork union members an upstream client cannot decode: a tag upstream's union
 * at the same path lacks, unless one of its members takes any tag there (the
 * V2 thread stream's unknown-event case). `forkOnlyLiterals` misses these,
 * since each member keys its own paths. Encoded side only: a member upstream
 * takes on the wire decodes, even when it decodes to a skip case.
 */
const forkOnlyMembers = (forkSchema: Codec, upstreamSchema: Codec) => {
  const upstreamSlots = collectLiterals(SchemaAST.toEncoded(upstreamSchema.ast));
  const upstreamUnions = unionTags(upstreamSlots);
  return [...unionTags(collectLiterals(SchemaAST.toEncoded(forkSchema.ast)))].flatMap(
    ([union, forkTags]) => {
      const upstreamTags = upstreamUnions.get(union);
      // A member tagged by several literals keys no path of its own: its tags sit in this slot.
      const shared = upstreamSlots.get(union);
      if (!upstreamTags || shared?.open) return [];
      return [...forkTags]
        .filter((tag) => !upstreamTags.has(tag) && !shared?.literals.has(tag))
        .map((tag) => `${union}: ${JSON.stringify(tag)}`);
    },
  );
};

const domainEventTypes = (events: DomainEventUnion) =>
  new Set(
    events.members.flatMap(({ fields: { type } }) =>
      type.literals ? [...type.literals] : type.literal ? [type.literal] : [],
    ),
  );

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
const project = {
  id: "project-compat",
  title: "Compat project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: "worktree",
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
const appThread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-compat",
  projectId: project.id,
  title: "Compat thread",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-compat" },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const threadShell = {
  ...appThread,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
};
const projection = {
  thread: appThread,
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
};
const shellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [project],
  threads: [threadShell],
  archivedThreads: [],
};
const eventBase = { id: "event-compat", threadId: appThread.id, occurredAt: now };

let fork: Contracts;
let upstream: Contracts;

beforeAll(async () => {
  [fork, upstream] = await Promise.all([loadForkContracts(), loadUpstreamContracts()]);
}, 60_000);

describe("an upstream client reading a fork server", () => {
  it("decodes every shell stream item and the shell snapshot route", () => {
    const items = [
      { kind: "synchronized" },
      { kind: "snapshot", snapshot: shellSnapshot },
      { kind: "project.updated", sequence: 2, project },
      { kind: "thread.updated", sequence: 3, location: "active", thread: threadShell },
      { kind: "thread.removed", sequence: 4, location: "archive", threadId: appThread.id },
      { kind: "project.removed", sequence: 5, projectId: project.id },
    ];
    for (const item of items) {
      const decoded = acrossTheWire(
        fork.OrchestrationV2ShellStreamItem,
        upstream.OrchestrationV2ShellStreamItem,
        item,
      );
      expect(decoded).toMatchObject({ kind: item.kind });
    }
    const archived = [
      {
        kind: "snapshot",
        snapshot: { schemaVersion: 1, snapshotSequence: 1, projects: [project], threads: [] },
      },
      { kind: "thread.updated", sequence: 2, thread: threadShell },
      { kind: "thread.removed", sequence: 3, threadId: appThread.id },
    ];
    for (const item of archived) {
      const decoded = acrossTheWire(
        fork.OrchestrationV2ArchivedShellStreamItem,
        upstream.OrchestrationV2ArchivedShellStreamItem,
        item,
      );
      expect(decoded).toMatchObject({ kind: item.kind });
    }
    expect(
      acrossTheWire(
        fork.OrchestrationV2ShellSnapshot,
        upstream.OrchestrationV2ShellSnapshot,
        shellSnapshot,
      ),
    ).toMatchObject({ threads: [{ id: appThread.id }], projects: [{ id: project.id }] });
  });

  it("decodes thread snapshots and known thread events", () => {
    const snapshot = acrossTheWire(
      fork.OrchestrationV2ThreadStreamItem,
      upstream.OrchestrationV2ThreadStreamItem,
      { kind: "snapshot", snapshotSequence: 1, projection },
    );
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      projection: { thread: { id: appThread.id } },
    });
    const pinned = acrossTheWire(
      fork.OrchestrationV2ThreadStreamItem,
      upstream.OrchestrationV2ThreadStreamItem,
      {
        kind: "event",
        sequence: 2,
        event: { ...eventBase, type: "thread.pinned", payload: { ...appThread, pinnedAt: now } },
      },
    );
    expect(pinned).toMatchObject({ kind: "event", event: { type: "thread.pinned" } });
    for (const name of [
      "OrchestrationV2ThreadDetailSnapshot",
      "OrchestrationV2ThreadBoundedSnapshot",
    ] as const) {
      const decoded = acrossTheWire(fork[name], upstream[name], {
        snapshotSequence: 1,
        projection,
        historyCursor: null,
        hasMoreHistory: false,
        latestLocalTurnOrdinal: null,
      });
      expect(decoded, name).toMatchObject({ projection: { thread: { id: appThread.id } } });
    }
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

  // V2 closes the shell streams but gives the thread stream a decode-only
  // unknown-event case, so a fork-only thread event is skipped upstream rather
  // than failing the subscription. The fork's issue events are the standing case.
  it("skips every fork-only thread event type instead of failing", () => {
    const upstreamTypes = domainEventTypes(upstream.OrchestrationV2DomainEvent);
    const forkOnly = [
      ...new Set([
        ...domainEventTypes(fork.OrchestrationV2DomainEvent),
        ...fork.THREAD_ISSUE_EVENT_TYPES_FORK,
      ]),
    ].filter((type) => !upstreamTypes.has(type));
    expect(forkOnly).toEqual(expect.arrayContaining(["thread.issue-linked"]));
    const decode = Schema.decodeUnknownSync(
      Schema.toCodecJson(upstream.OrchestrationV2ThreadStreamItem),
    );
    for (const [index, type] of forkOnly.entries()) {
      const item = {
        kind: "event",
        sequence: index + 2,
        event: { ...eventBase, type, payload: { threadId: appThread.id, link: issue } },
      };
      expect(decode(JSON.parse(JSON.stringify(item))), type).toEqual({
        kind: "unknown-event",
        sequence: index + 2,
        eventType: type,
      });
    }
  });

  // Durable guard: a fork member in a closed union upstream decodes fails here,
  // since such a client fails the whole subscription on it.
  it("adds no member to a closed union an upstream client decodes", () => {
    for (const name of wireSchemas) {
      expect(forkOnlyMembers(fork[name], upstream[name]), name).toEqual([]);
    }
    // The guard flags a fork member of a closed union and passes one of an open union.
    const issueMember = (tagField: "kind" | "type") =>
      Schema.Struct({ [tagField]: Schema.Literal("thread.issue-linked"), threadId: Schema.String });
    const widenedShell = Schema.Union([
      upstream.OrchestrationV2ShellStreamItem,
      issueMember("kind"),
    ]) as unknown as Codec;
    expect(forkOnlyMembers(widenedShell, upstream.OrchestrationV2ShellStreamItem)).toEqual([
      '$.kind: "thread.issue-linked"',
    ]);
    const widenedThread = Schema.Union([
      upstream.OrchestrationV2ThreadStreamItem,
      Schema.Struct({
        kind: Schema.Literal("event"),
        sequence: Schema.Number,
        event: issueMember("type"),
      }),
    ]) as unknown as Codec;
    expect(forkOnlyMembers(widenedThread, upstream.OrchestrationV2ThreadStreamItem)).toEqual([]);
  });
});
