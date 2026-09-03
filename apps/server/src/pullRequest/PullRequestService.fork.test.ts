import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry, fromProviders } from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import { PullRequestAttachmentStore } from "./PullRequestAttachmentStore.ts";
function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
}): OrchestrationProjectShell {
  // The host defaults from the provider, so a fixture only names one when the point of the
  // test is two hosts of the same kind.
  const host = input.host ?? (input.provider === "gitlab" ? "gitlab.com" : "github.com");
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: `${host}/${input.repository}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${host}/${input.repository}.git`,
            },
            provider: input.provider ?? "github",
            displayName: input.repository,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}
function changeRequest(number: number, updatedAt: string): ProviderChangeRequest {
  return {
    number,
    title: `Change request ${number}`,
    url: `https://host/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    reviewRequestLogins: [],
    labels: [],
  };
}
function unusable(provider: SourceControlProviderKind, reason: "missing-tool" | "unauthenticated") {
  return new PullRequestProviderError({
    provider,
    operation: "getViewer",
    reason,
    detail: `${provider} is not usable.`,
  });
}
const requestFailed = new PullRequestProviderError({
  provider: "github",
  operation: "listChangeRequests",
  reason: "failed",
  detail: "HTTP 404",
});
/** Everything a host could offer, so a fixture only narrows what its own test is about. */
const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};
const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };
/** A provider whose every call is supplied by the test; anything unset succeeds emptily. */
function fakeProvider(
  kind: SourceControlProviderKind,
  overrides: Partial<PullRequestProviderApi> = {},
): PullRequestProviderApi {
  return {
    kind,
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "draft", "close", "reopen"],
      mergeMethods: ["merge"],
      search: true,
      reactions: true,
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
      edit: { changeRequest: true, comment: true },
    },
    getViewer: () => Effect.succeed("bilal"),
    // A viewer who may do everything the host can, so a test only narrows what it is about.
    getViewerPermissions: () =>
      Effect.succeed({
        actions: ["merge", "ready", "draft", "close", "reopen"],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: true,
      }),
    listChangeRequests: () => Effect.succeed({ items: [], truncated: false, continues: true }),
    getChangeRequest: () => Effect.die("unused"),
    getChangeRequestActivity: () => Effect.die("unused"),
    getDiff: () => Effect.die("unused"),
    runAction: () => Effect.void,
    updateChangeRequest: () => Effect.void,
    comment: () => Effect.void,
    updateComment: () => Effect.void,
    submitReview: () => Effect.void,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    setReaction: () => Effect.void,
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () => Effect.void,
    ...overrides,
  };
}
function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<PullRequestProviderApi>;
  readonly resolveHandle?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]["resolveHandle"];
  readonly attachmentStore?: Partial<PullRequestAttachmentStore["Service"]>;
}) {
  return PullRequestService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PullRequestProviderRegistry, fromProviders(input.providers)),
        Layer.mock(PullRequestAttachmentStore)({
          createUploadUrl: () => Effect.die("unused"),
          resolvePendingPath: () => null,
          deletePending: () => Effect.void,
          ...input.attachmentStore,
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveHandle:
            input.resolveHandle ?? (() => Effect.die("Unexpected provider refinement")),
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: input.projects,
              threads: [],
              updatedAt: "2026-07-01T00:00:00Z",
            }),
        }),
        SourceControlRateLimit.layer,
      ),
    ),
  );
}
/** A row as a host that reads several repositories at once hands it over. */
function batchedChangeRequest(number: number, repository: string, updatedAt: string) {
  return { ...changeRequest(number, updatedAt), repository };
}
it.effect("uses the requested project to read another repository on the same host", () =>
  Effect.gen(function* () {
    const repositories: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          getDiff: (input) => {
            repositories.push(input.repository);
            return Effect.succeed({ patch: "", truncated: false, nextCursor: null });
          },
        }),
      ],
    });
    yield* service.diff({
      projectId: "p1" as ProjectId,
      repository: "other/repo",
      number: 1,
    });
    assert.deepStrictEqual(repositories, ["other/repo"]);
  }),
);
it.effect("stages and publishes an attachment through the selected project's provider", () =>
  Effect.gen(function* () {
    const staged: Array<{
      name: string;
      mimeType: string;
      sizeBytes: number;
    }> = [];
    const published: Array<{
      cwd: string;
      repository: string;
      host: string;
      path: string;
      name: string;
      mimeType: string;
    }> = [];
    const deleted: Array<string> = [];
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            ...fakeProvider("github").capabilities,
            attachments: true,
          },
          uploadAttachment: (input) => {
            published.push(input);
            return Effect.succeed("![demo.png](https://github.com/user-attachments/assets/id)");
          },
        }),
      ],
      attachmentStore: {
        createUploadUrl: (input) => {
          staged.push(input);
          return Effect.succeed({
            attachmentId: "pending-id",
            relativeUrl: "/api/attachments/upload?token=signed",
            expiresAt: 123,
          });
        },
        resolvePendingPath: (attachmentId) =>
          attachmentId === "pending-id" ? "/staged/pending-id.png" : null,
        deletePending: (attachmentId) =>
          Effect.sync(() => {
            deleted.push(attachmentId);
          }),
      },
    });
    const prepared = yield* service.createAttachmentUploadUrl({
      ...reference,
      name: "demo.png",
      mimeType: "image/png",
      sizeBytes: 42,
    });
    const uploaded = yield* service.uploadAttachment({
      ...reference,
      name: "demo.png",
      mimeType: "image/png",
      attachmentId: prepared.attachmentId,
    });
    assert.deepStrictEqual(staged, [{ name: "demo.png", mimeType: "image/png", sizeBytes: 42 }]);
    assert.deepStrictEqual(published, [
      {
        cwd: "/a",
        repository: "acme/web",
        host: "github.com",
        path: "/staged/pending-id.png",
        name: "demo.png",
        mimeType: "image/png",
      },
    ]);
    assert.deepStrictEqual(uploaded, {
      insertion: "![demo.png](https://github.com/user-attachments/assets/id)",
    });
    assert.deepStrictEqual(deleted, ["pending-id"]);
  }),
);
it.effect("removes a staged attachment when publication fails", () =>
  Effect.gen(function* () {
    const deleted: Array<string> = [];
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            ...fakeProvider("github").capabilities,
            attachments: true,
          },
          uploadAttachment: () => Effect.fail(requestFailed),
        }),
      ],
      attachmentStore: {
        resolvePendingPath: () => "/staged/pending-id.png",
        deletePending: (attachmentId) =>
          Effect.sync(() => {
            deleted.push(attachmentId);
          }),
      },
    });
    const error = yield* Effect.flip(
      service.uploadAttachment({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        name: "demo.png",
        mimeType: "image/png",
        attachmentId: "pending-id",
      }),
    );
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.deepStrictEqual(deleted, ["pending-id"]);
  }),
);
