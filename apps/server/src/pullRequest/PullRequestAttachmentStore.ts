import type {
  AttachmentCreateUploadUrlResult,
  AttachmentUploadSigningKeyError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { deletePendingAttachment, issueAttachmentUploadUrl } from "../assets/AttachmentUpload.ts";
import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class PullRequestAttachmentStore extends Context.Service<
  PullRequestAttachmentStore,
  {
    readonly createUploadUrl: (input: {
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    }) => Effect.Effect<AttachmentCreateUploadUrlResult, AttachmentUploadSigningKeyError>;
    readonly resolvePendingPath: (attachmentId: string) => string | null;
    readonly deletePending: (attachmentId: string) => Effect.Effect<void>;
  }
>()("t3/pullRequest/PullRequestAttachmentStore") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  return PullRequestAttachmentStore.of({
    createUploadUrl: (input) =>
      issueAttachmentUploadUrl(input).pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      ),
    resolvePendingPath: (attachmentId) => {
      if (parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
        return null;
      }
      return resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId });
    },
    deletePending: (attachmentId) =>
      deletePendingAttachment(attachmentId).pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
  });
});

export const layer = Layer.effect(PullRequestAttachmentStore, make);
