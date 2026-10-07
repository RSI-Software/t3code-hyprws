import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpServer, type Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  IssuesToolkitHandlersLiveFork,
  IssuesToolkitRegistrationLiveFork,
  parseGitHubIssueUrlFork,
} from "./handlers.fork.ts";
import { IssuesToolkitFork } from "./tools.fork.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session:provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["pull-requests"]),
  issuedAt: 1,
};

const GITHUB_IDENTITY: OrchestrationProjectShell["repositoryIdentity"] = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:T3Tools/T3Code.git",
  },
  provider: "github",
  displayName: "T3Tools/T3Code",
  owner: "T3Tools",
  name: "T3Code",
};

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = GITHUB_IDENTITY,
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

/** A shell carrying the optional `issues` key, omitted when empty like the server omits it. */
function makeThread(issues: ReadonlyArray<ThreadIssueLink> = []): OrchestrationV2ThreadShell {
  const shell = v2PullRequestThread({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  });
  return issues.length === 0 ? shell : { ...shell, issues };
}

function makeLink(number: number, overrides: Partial<ThreadIssueLink> = {}): ThreadIssueLink {
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/issues/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot: null,
    ...overrides,
  };
}

/** The orchestrator's refusal: a dispatch error carrying the reason as its cause. */
const rejectAs = (detail: string) => (command: OrchestrationCommand) =>
  new Orchestrator.OrchestratorDispatchError({
    commandId: command.commandId,
    commandType: command.type,
    cause: detail,
  });

interface HarnessOptions {
  readonly thread?: OrchestrationV2ThreadShell | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly reject?: (
    command: OrchestrationCommand,
  ) => Orchestrator.OrchestratorDispatchError | null;
  /** What shell reads see once a command is dispatched, such as the thread deleted meanwhile. */
  readonly threadAfterDispatch?: OrchestrationV2ThreadShell | null;
}

/** The thread shell reads see; dispatch may replace it. */
interface ThreadState {
  current: OrchestrationV2ThreadShell | null;
}

function harnessDependencies(
  options: HarnessOptions,
  dispatch: Orchestrator.OrchestratorV2Shape["dispatch"],
  state: ThreadState = { current: options.thread === undefined ? makeThread() : options.thread },
) {
  const project = options.project === undefined ? makeProject() : options.project;
  return Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeed(Option.fromNullishOr(project)),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (threadId) => Effect.succeed(threadId === THREAD_ID ? state.current : null),
      dispatch,
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
}

const makeHarness = Effect.fn("makeIssuesToolkitHarness")(function* (options: HarnessOptions = {}) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const state: ThreadState = {
    current: options.thread === undefined ? makeThread() : options.thread,
  };
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      if (options.threadAfterDispatch !== undefined) state.current = options.threadAfterDispatch;
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) return yield* rejection;
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1, storedEvents: [] };
    });
  const dependencies = harnessDependencies(options, dispatch, state);
  const toolkit = yield* IssuesToolkitFork.pipe(
    Effect.provide(IssuesToolkitHandlersLiveFork.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof IssuesToolkitFork.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof IssuesToolkitFork.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("issue toolkit handlers", () => {
  it.effect("registers the three issue tools with the pull request tools' annotations", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      expect(names).toEqual(["link_issue", "unlink_issue", "list_thread_issues"]);
      const link = server.tools.find(({ tool }) => tool.name === "link_issue");
      expect(link?.tool.annotations?.idempotentHint).toBe(true);
      expect(link?.tool.annotations?.openWorldHint).toBe(false);
    }).pipe(
      Effect.provide(
        IssuesToolkitRegistrationLiveFork.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(
            Layer.mergeAll(
              harnessDependencies({}, () => Effect.die("unused")),
              NodeServices.layer,
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("links by URL with source agent, storing only the canonical issue URL", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_issue", {
        url: "http://agent:secret@github.com/T3Tools/T3Code/issues/123/?token=private-value#issuecomment-1",
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 123,
        url: "https://github.com/t3tools/t3code/issues/123",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.issue.link",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 123,
          url: "https://github.com/t3tools/t3code/issues/123",
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("links by repository and number, defaulting the host to the project's", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_issue", { repository: "T3Tools/Other", number: 7 });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/other",
        number: 7,
        url: "https://github.com/t3tools/other/issues/7",
        alreadyLinked: false,
      });
    }),
  );

  it.effect("treats a duplicate link as alreadyLinked rather than an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(123)]),
        reject: rejectAs("already linked"),
      });
      const result = yield* harness.call("link_issue", {
        url: "https://github.com/t3tools/t3code/issues/123",
      });
      expect(result.alreadyLinked).toBe(true);
    }),
  );

  it.effect("unlinks a linked issue and reports a missing one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: (command) =>
          command.type === "thread.issue.unlink" && command.number !== 5
            ? rejectAs("not linked")(command)
            : null,
      });
      const linked = yield* harness.call("unlink_issue", {
        repository: "t3tools/t3code",
        number: 5,
      });
      expect(linked).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 5,
        wasLinked: true,
      });
      const missing = yield* harness.call("unlink_issue", {
        url: "https://github.com/t3tools/t3code/issues/9",
      });
      expect(missing.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.issue.unlink", number: 5 },
      ]);
    }),
  );

  it.effect("reports a thread deleted between lookup and dispatch as not found", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        threadAfterDispatch: null,
        reject: rejectAs("Thread 'thread-1' does not exist"),
      });
      const link = yield* harness
        .call("link_issue", { url: "https://github.com/t3tools/t3code/issues/123" })
        .pipe(Effect.flip);
      expect(link).toMatchObject({ _tag: "IssueThreadNotFoundError", threadId: THREAD_ID });
      const unlink = yield* harness
        .call("unlink_issue", { repository: "t3tools/t3code", number: 9 })
        .pipe(Effect.flip);
      expect(unlink).toMatchObject({ _tag: "IssueThreadNotFoundError", threadId: THREAD_ID });
    }),
  );

  it.effect("fails an unrelated rejection that leaves the link in the wrong state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: rejectAs("thread thread-1 is deleted"),
      });
      const link = yield* harness
        .call("link_issue", { url: "https://github.com/t3tools/t3code/issues/123" })
        .pipe(Effect.flip);
      expect(link).toMatchObject({ _tag: "IssueLinkFailedError" });
      const unlink = yield* harness
        .call("unlink_issue", { repository: "t3tools/t3code", number: 5 })
        .pipe(Effect.flip);
      expect(unlink).toMatchObject({ _tag: "IssueUnlinkFailedError" });
    }),
  );

  it.effect("lists the shell's links, with unknown state until the first read", () =>
    Effect.gen(function* () {
      const synced = makeLink(3, {
        source: "agent",
        snapshot: {
          title: "Crash on start",
          state: "closed",
          syncedAt: "2026-08-11T00:00:00.000Z",
        },
      });
      const harness = yield* makeHarness({ thread: makeThread([synced, makeLink(4)]) });
      expect(yield* harness.call("list_thread_issues", {})).toEqual({
        issues: [
          {
            host: "github.com",
            repository: "t3tools/t3code",
            number: 3,
            url: "https://github.com/t3tools/t3code/issues/3",
            source: "agent",
            state: "closed",
            title: "Crash on start",
          },
          {
            host: "github.com",
            repository: "t3tools/t3code",
            number: 4,
            url: "https://github.com/t3tools/t3code/issues/4",
            source: "manual",
            state: null,
            title: null,
          },
        ],
      });
      const empty = yield* makeHarness();
      expect(yield* empty.call("list_thread_issues", {})).toEqual({ issues: [] });
    }),
  );

  it.effect("rejects an invalid reference without dispatching", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const incomplete = yield* harness.call("link_issue", { repository: "x/y" }).pipe(Effect.flip);
      expect(incomplete).toMatchObject({ _tag: "IssueTargetIncompleteError" });
      for (const url of [
        "https://github.com/t3tools/t3code/pull/1?token=private-value",
        "https://forge.example/owner/repo/issues/1",
        "mailto:someone@github.com",
      ]) {
        const error = yield* harness.call("link_issue", { url }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "IssueUrlInvalidError" });
        expect(error.message).not.toContain("private-value");
      }
      const offGitHub = yield* makeHarness({
        project: makeProject({
          canonicalKey: "gitlab.com/group/project",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:group/project.git",
          },
          provider: "gitlab",
          displayName: "group/project",
        }),
      });
      const hostless = yield* offGitHub
        .call("unlink_issue", { repository: "group/project", number: 1 })
        .pipe(Effect.flip);
      expect(hostless).toMatchObject({ _tag: "IssueHostRequiredError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(yield* Ref.get(offGitHub.commands)).toEqual([]);
    }),
  );

  it.effect("fails cleanly when the token's thread no longer exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: null });
      const error = yield* harness
        .call("link_issue", { url: "https://github.com/t3tools/t3code/issues/1" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "IssueThreadNotFoundError", threadId: THREAD_ID });
    }),
  );

  it("believes an issue URL only from github.com or the project's own host", () => {
    const enterprise = "https://git.corp.example/Team/App/issues/12";
    expect(parseGitHubIssueUrlFork(enterprise, null)).toBeNull();
    expect(parseGitHubIssueUrlFork(enterprise, "git.corp.example")).toEqual({
      host: "git.corp.example",
      repository: "team/app",
      number: 12,
      url: "https://git.corp.example/team/app/issues/12",
    });
    for (const lookalike of [
      "https://github.example.com/a/b/issues/3",
      "https://github.com.evil.example/a/b/issues/3",
      "https://api.github.com/a/b/issues/3",
    ]) {
      expect(parseGitHubIssueUrlFork(lookalike, "git.corp.example")).toBeNull();
    }
    expect(
      parseGitHubIssueUrlFork(
        "https://git.corp.example:9443/a/b/issues/3",
        "git.corp.example:8443",
      ),
    ).toBeNull();
    expect(parseGitHubIssueUrlFork("https://github.com/a/b/issues/0", null)).toBeNull();
  });

  it.effect("keeps the port of a project's configured GitHub host", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          ...GITHUB_IDENTITY,
          canonicalKey: "ghe.corp.example/team/app",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://ghe.corp.example:8443/Team/App.git",
          },
        }),
      });
      const byUrl = yield* harness.call("link_issue", {
        url: "https://ghe.corp.example:8443/Team/App/issues/12?tab=timeline",
      });
      expect(byUrl).toEqual({
        host: "ghe.corp.example:8443",
        repository: "team/app",
        number: 12,
        url: "https://ghe.corp.example:8443/team/app/issues/12",
        alreadyLinked: false,
      });
      const byNumber = yield* harness.call("link_issue", { repository: "Team/App", number: 13 });
      expect(byNumber).toMatchObject({
        host: "ghe.corp.example:8443",
        url: "https://ghe.corp.example:8443/team/app/issues/13",
      });
      const lookalike = yield* harness
        .call("link_issue", { url: "https://github.corp.example/Team/App/issues/12" })
        .pipe(Effect.flip);
      expect(lookalike).toMatchObject({ _tag: "IssueUrlInvalidError" });
    }),
  );
});
