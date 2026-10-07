// Fork-owned handlers for the thread ↔ GitHub issue MCP tools
// (RSI-Software/t3code-hyprws#1433), mirroring upstream's pull request
// handlers in `../pullRequests/handlers.ts`. Every call acts on the calling
// agent's own thread, links with source `agent`, and resolves the layer-1
// decider's duplicate and missing-link rejections into idempotent results
// only once a reread of the thread confirms that outcome.
import {
  CommandId,
  pullRequestHostOf,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpServer } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import {
  normalizeThreadIssueKey,
  threadIssueKeysEqual,
} from "../../../orchestration-v2/ThreadIssues.fork.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  IssueHostRequiredError,
  IssueLinkFailedError,
  IssueListFailedError,
  IssuesToolkitFork,
  type IssueTargetInput,
  IssueTargetIncompleteError,
  IssueThreadNotFoundError,
  IssueUnlinkFailedError,
  IssueUrlInvalidError,
  type ListThreadIssuesResult,
} from "./tools.fork.ts";

interface ResolvedIssueTarget extends ThreadIssueKey {
  readonly url: string;
}

const GITHUB_ISSUE_PATH = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u;

/** The one GitHub host believed without a project on it. */
const GITHUB_DOT_COM = "github.com";

/**
 * The project's GitHub host, or null when the project is not on GitHub. The
 * canonical key drops a port, so an HTTP(S) remote on that host lends its own;
 * an SSH remote's port is not the web port and is left off.
 */
function projectGitHubHost(project: OrchestrationProjectShell | undefined): string | null {
  const identity = project?.repositoryIdentity;
  if (!identity || identity.provider !== "github") return null;
  const host = pullRequestHostOf(identity, "github").toLowerCase();
  try {
    const remote = new URL(identity.locator.remoteUrl);
    if (
      (remote.protocol === "https:" || remote.protocol === "http:") &&
      remote.hostname.toLowerCase() === host
    ) {
      return remote.host.toLowerCase();
    }
  } catch {
    // SSH remotes keep the canonical host.
  }
  return host;
}

/** The web URL of an issue, carrying nothing of the text it was read from. */
function canonicalIssueUrl(key: ThreadIssueKey, protocol = "https:"): string {
  return `${protocol}//${key.host}/${key.repository}/issues/${key.number}`;
}

/**
 * The identity and canonical URL behind a GitHub issue URL, or null for
 * anything else. Only github.com and the project's own GitHub host (with its
 * port) are believed: Forgejo and Gitea share GitHub's `/owner/repo/issues/N`
 * path, and a `github.*` lookalike name proves nothing.
 */
export function parseGitHubIssueUrlFork(
  targetUrl: string,
  projectHost: string | null,
): ResolvedIssueTarget | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.host.toLowerCase();
  const onProjectHost = host === projectHost || url.hostname.toLowerCase() === projectHost;
  if (host !== GITHUB_DOT_COM && !onProjectHost) return null;
  const match = GITHUB_ISSUE_PATH.exec(url.pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  if (!repository || !Number.isSafeInteger(number) || number <= 0) return null;
  const key = normalizeThreadIssueKey({ host, repository, number });
  // github.com is HTTPS-only; an Enterprise host keeps the scheme it was reached by.
  return { ...key, url: canonicalIssueUrl(key, host === GITHUB_DOT_COM ? "https:" : url.protocol) };
}

/**
 * Turns whichever shape the agent passed into one host-level identity. A URL
 * wins outright; otherwise the repository and number are completed with the
 * thread's project host when that project is on GitHub.
 */
const resolveIssueTarget = Effect.fn("IssuesToolkitFork.resolveTarget")(function* (
  input: IssueTargetInput,
  project: OrchestrationProjectShell | undefined,
) {
  const projectHost = projectGitHubHost(project);
  if (input.url !== undefined) {
    const parsed = parseGitHubIssueUrlFork(input.url, projectHost);
    if (parsed === null) {
      return yield* new IssueUrlInvalidError({});
    }
    return parsed;
  }
  if (input.repository === undefined || input.number === undefined) {
    return yield* new IssueTargetIncompleteError({});
  }
  const host = (input.host ?? projectHost)?.toLowerCase();
  if (host === undefined || host === null) {
    return yield* new IssueHostRequiredError({});
  }
  const key = normalizeThreadIssueKey({ host, repository: input.repository, number: input.number });
  return { ...key, url: canonicalIssueUrl(key) } satisfies ResolvedIssueTarget;
});

/** The thread shell's `issues` key is omitted when the thread has none, like `pullRequests` beside it. */
type ThreadIssuesShell = Pick<OrchestrationV2ThreadShell, "id" | "issues">;

/** What `list_thread_issues` reports from a thread shell. */
function listThreadIssuesFork(thread: ThreadIssuesShell): ListThreadIssuesResult {
  return {
    issues: (thread.issues ?? []).map((link) => ({
      host: link.host,
      repository: link.repository,
      number: link.number,
      url: link.url,
      source: link.source,
      state: link.snapshot?.state ?? null,
      title: link.snapshot?.title ?? null,
    })),
  };
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const readThread = Effect.fn("IssuesToolkitFork.readThread")(function* (
    threadId: ThreadId,
    Failure:
      | typeof IssueLinkFailedError
      | typeof IssueUnlinkFailedError
      | typeof IssueListFailedError,
  ) {
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (thread === null) {
      return yield* new IssueThreadNotFoundError({ threadId });
    }
    return thread;
  });

  const requireThread = Effect.fn("IssuesToolkitFork.requireThread")(function* (
    Failure:
      | typeof IssueLinkFailedError
      | typeof IssueUnlinkFailedError
      | typeof IssueListFailedError,
  ) {
    // Every agent credential carries the thread-link capability upstream grants
    // for pull requests; issue links are the same authority over the same thread.
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    // Issue tools act as the calling thread; a client signed in outside one has none.
    if (scope.thread === undefined) {
      return yield* new Failure({ cause: new Error("Issue tools need a calling T3 thread.") });
    }
    return yield* readThread(scope.thread.threadId, Failure);
  });

  /**
   * The orchestrator refuses a duplicate link and an absent unlink with the same
   * dispatch error as a missing or deleted thread, so a refusal is read back
   * against the thread. It is the agent's idempotent success only when the
   * thread still exists and this exact link is in the state the call wanted.
   */
  const confirmRejection = Effect.fn("IssuesToolkitFork.confirmRejection")(function* (
    threadId: ThreadId,
    key: ThreadIssueKey,
    wantLinked: boolean,
    Failure: typeof IssueLinkFailedError | typeof IssueUnlinkFailedError,
    rejection: Orchestrator.OrchestratorDispatchError,
  ) {
    const thread = yield* readThread(threadId, Failure);
    const linked = (thread.issues ?? []).some((link) => threadIssueKeysEqual(link, key));
    if (linked !== wantLinked) {
      return yield* new Failure({ cause: rejection });
    }
  });

  const projectOf = (
    thread: OrchestrationV2ThreadShell,
    Failure: typeof IssueLinkFailedError | typeof IssueUnlinkFailedError,
  ) =>
    projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new Failure({ cause })),
    );

  const dispatchFailure =
    (Failure: typeof IssueLinkFailedError | typeof IssueUnlinkFailedError) =>
    <E>(
      cause: Cause.Cause<E>,
    ): Effect.Effect<never, IssueLinkFailedError | IssueUnlinkFailedError> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }));

  return IssuesToolkitFork.of({
    link_issue: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(IssueLinkFailedError);
        const project = yield* projectOf(thread, IssueLinkFailedError);
        const target = yield* resolveIssueTarget(input, project);
        const rejection = yield* engine
          .dispatch({
            type: "thread.issue.link",
            commandId: yield* commandId("mcp-issue-link", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
            url: target.url,
            source: "agent",
          })
          .pipe(
            Effect.as(null),
            Effect.catchTags({
              OrchestratorDispatchError: (rejection) => Effect.succeed(rejection),
            }),
            Effect.catchCause(dispatchFailure(IssueLinkFailedError)),
          );
        if (rejection !== null) {
          yield* confirmRejection(thread.id, target, true, IssueLinkFailedError, rejection);
        }
        return { ...target, alreadyLinked: rejection !== null };
      }),
    unlink_issue: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(IssueUnlinkFailedError);
        const project = yield* projectOf(thread, IssueUnlinkFailedError);
        const target = yield* resolveIssueTarget(input, project);
        const rejection = yield* engine
          .dispatch({
            type: "thread.issue.unlink",
            commandId: yield* commandId("mcp-issue-unlink", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
          })
          .pipe(
            Effect.as(null),
            Effect.catchTags({
              OrchestratorDispatchError: (rejection) => Effect.succeed(rejection),
            }),
            Effect.catchCause(dispatchFailure(IssueUnlinkFailedError)),
          );
        if (rejection !== null) {
          yield* confirmRejection(thread.id, target, false, IssueUnlinkFailedError, rejection);
        }
        return {
          host: target.host,
          repository: target.repository,
          number: target.number,
          wasLinked: rejection === null,
        };
      }),
    list_thread_issues: () =>
      requireThread(IssueListFailedError).pipe(Effect.map(listThreadIssuesFork)),
  });
});

export const IssuesToolkitHandlersLiveFork = IssuesToolkitFork.toLayer(make);

/** Spread into `McpHttpServer.layer` through the marked `github-issues/mcp-issues-toolkit` hook. */
export const IssuesToolkitRegistrationLiveFork = McpServer.toolkit(IssuesToolkitFork).pipe(
  Layer.provide(IssuesToolkitHandlersLiveFork),
);
