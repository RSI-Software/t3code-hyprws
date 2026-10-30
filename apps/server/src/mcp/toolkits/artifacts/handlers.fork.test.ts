import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type ThreadArtifactLink,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { ArtifactsToolkitHandlersLiveFork } from "./handlers.fork.ts";
import { ArtifactsToolkitFork } from "./tools.fork.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

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

function makeLink(path: string): ThreadArtifactLink {
  return {
    path,
    title: "Tracker",
    source: "agent",
    linkedAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    missing: false,
  };
}

function makeThread(artifacts: ReadonlyArray<ThreadArtifactLink> = []): OrchestrationV2ThreadShell {
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
  return artifacts.length === 0 ? shell : { ...shell, artifacts };
}

/** A project rooted in a scratch directory, holding `notes/tracker.html` and `notes/`. */
const makeHarness = Effect.fn("makeArtifactsToolkitHarness")(function* (
  artifacts: (root: string) => ReadonlyArray<ThreadArtifactLink> = () => [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-artifact-tools-" });
  yield* fs.makeDirectory(path.join(root, "notes"));
  yield* fs.writeFileString(path.join(root, "notes", "tracker.html"), "<h1>Tracker</h1>");
  const project = { id: PROJECT_ID, workspaceRoot: root } as OrchestrationProjectShell;
  const thread = makeThread(artifacts(root));
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeedSome(project),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (threadId) => Effect.succeed(threadId === THREAD_ID ? thread : null),
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(7),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
    McpToolAccessTestkit.liveThreadsLayer,
    NodeServices.layer,
  );
  const toolkit = yield* ArtifactsToolkitFork.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ArtifactsToolkitHandlersLiveFork).pipe(
        Layer.provide(dependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof ArtifactsToolkitFork.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ArtifactsToolkitFork.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(dependencies),
    );
  return { root, tracker: path.join(root, "notes", "tracker.html"), commands, call };
});

describe("artifact toolkit handlers", () => {
  it.effect("links a workspace-relative path as agent, titled by its file name", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_artifact", {
        path: "./notes/../notes/tracker.html",
      });
      expect(result).toEqual({
        path: harness.tracker,
        title: "tracker.html",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.artifact.link",
          threadId: THREAD_ID,
          path: harness.tracker,
          title: "tracker.html",
          source: "agent",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("relinks an already-linked path with the new title", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((root) => [makeLink(`${root}/notes/tracker.html`)]);
      const result = yield* harness.call("link_artifact", {
        path: harness.tracker,
        title: "Rollout",
      });
      expect(result).toEqual({ path: harness.tracker, title: "Rollout", alreadyLinked: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([{ title: "Rollout" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a missing file or a directory without dispatching", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const missing = yield* harness
        .call("link_artifact", { path: "notes/plan.md" })
        .pipe(Effect.flip);
      expect(missing).toMatchObject({
        _tag: "ArtifactFileNotFoundError",
        path: `${harness.root}/notes/plan.md`,
      });
      const directory = yield* harness.call("link_artifact", { path: "notes" }).pipe(Effect.flip);
      expect(directory).toMatchObject({ _tag: "ArtifactNotAFileError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("unlinks a linked path and reports an unlinked one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((root) => [makeLink(`${root}/notes/tracker.html`)]);
      const other = yield* harness.call("unlink_artifact", { path: "notes/plan.md" });
      expect(other).toEqual({ path: `${harness.root}/notes/plan.md`, wasLinked: false });
      const linked = yield* harness.call("unlink_artifact", { path: "notes/tracker.html" });
      expect(linked).toEqual({ path: harness.tracker, wasLinked: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.artifact.unlink", path: harness.tracker },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
