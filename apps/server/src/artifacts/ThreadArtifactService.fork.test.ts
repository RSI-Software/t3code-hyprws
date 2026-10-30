import {
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

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadArtifactService from "./ThreadArtifactService.fork.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

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
const makeHarness = Effect.fn("makeThreadArtifactServiceHarness")(function* (
  artifacts: (root: string) => ReadonlyArray<ThreadArtifactLink> = () => [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-artifact-service-" });
  yield* fs.makeDirectory(path.join(root, "notes"));
  yield* fs.writeFileString(path.join(root, "notes", "tracker.html"), "<h1>Tracker</h1>");
  const project = { id: PROJECT_ID, workspaceRoot: root } as OrchestrationProjectShell;
  const thread = makeThread(artifacts(root));
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const service = yield* ThreadArtifactService.ThreadArtifactService.pipe(
    Effect.provide(
      ThreadArtifactService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
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
            NodeServices.layer,
          ),
        ),
      ),
    ),
  );
  return { root, tracker: path.join(root, "notes", "tracker.html"), commands, service };
});

describe("ThreadArtifactService", () => {
  it.effect("links a workspace-relative path, titled by its file name", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.service.link({
        threadId: THREAD_ID,
        path: "./notes/../notes/tracker.html",
        source: "agent",
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
      const result = yield* harness.service.link({
        threadId: THREAD_ID,
        path: harness.tracker,
        title: "Rollout",
        source: "agent",
      });
      expect(result).toEqual({ path: harness.tracker, title: "Rollout", alreadyLinked: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([{ title: "Rollout" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a missing file, a directory, or a network path without dispatching", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const link = (path: string) =>
        harness.service.link({ threadId: THREAD_ID, path, source: "agent" }).pipe(Effect.flip);
      expect(yield* link("notes/plan.md")).toMatchObject({
        _tag: "ArtifactFileNotFoundError",
        path: `${harness.root}/notes/plan.md`,
      });
      expect(yield* link("notes")).toMatchObject({ _tag: "ArtifactNotAFileError" });
      expect(yield* link("//attacker/share/plan.md")).toMatchObject({
        _tag: "ArtifactNetworkPathError",
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("unlinks a linked path and reports an unlinked one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((root) => [makeLink(`${root}/notes/tracker.html`)]);
      const unlink = (path: string) => harness.service.unlink({ threadId: THREAD_ID, path });
      const other = yield* unlink("notes/plan.md");
      expect(other).toEqual({ path: `${harness.root}/notes/plan.md`, wasLinked: false });
      const linked = yield* unlink("notes/tracker.html");
      expect(linked).toEqual({ path: harness.tracker, wasLinked: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.artifact.unlink", path: harness.tracker },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
