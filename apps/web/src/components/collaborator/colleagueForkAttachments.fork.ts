// Fork-only (colleague-collab): copies one image or file of a colleague's thread onto this machine
// for "Fork to my machine". The host mints a signed URL for it, as it does to show it, and the
// bytes upload here as a pending attachment, which the fork then claims for the new thread.
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { awaitAtomResult } from "@t3tools/client-runtime/state/runtime";
import {
  type AttachmentCreateUploadUrlInput,
  type ChatAttachment,
  ChatAttachmentId,
  type EnvironmentId,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { AtomRegistry } from "effect/reactivity";

import { assetEnvironment } from "~/state/assets";
import { attachmentEnvironment } from "~/state/attachments";
import { readPreparedConnection } from "~/state/session";

// The dialog cannot close while it forks, so a stalled transfer counts as not copied.
const COPY_TIMEOUT = "1 minute";

/** The upload slot `attachment` needs here, or null for a kind this server takes no upload of. */
const uploadOf = (attachment: ChatAttachment): AttachmentCreateUploadUrlInput | null => {
  const { name, sizeBytes } = attachment;
  if (attachment.type === "file") {
    return { type: "file", name, mimeType: attachment.mimeType, sizeBytes };
  }
  const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
    (supported) => supported === attachment.mimeType.toLowerCase(),
  );
  return attachment.type === "image" && mimeType !== undefined
    ? { name, mimeType, sizeBytes }
    : null;
};

/**
 * Copies `attachment` from the host `from` to this machine's server `to`. Yields the pending copy,
 * or null when it cannot be read or stored here.
 */
export const copyColleagueAttachmentFork = (
  registry: AtomRegistry.AtomRegistry,
  from: EnvironmentId,
  to: EnvironmentId,
) =>
  Effect.fn("ColleagueFork.copyAttachment")(function* (attachment: ChatAttachment) {
    const upload = uploadOf(attachment);
    const host = readPreparedConnection(from);
    if (upload === null || host === null) return null;
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const minted = yield* awaitAtomResult(
      registry,
      assetEnvironment.createUrl({
        environmentId: from,
        input: { resource: { _tag: "attachment", attachmentId: attachment.id } },
      }),
    );
    const url = resolveAssetUrl(host.httpBaseUrl, minted.relativeUrl);
    if (url === null) return null;
    const bytes = new Uint8Array(yield* (yield* http.get(url)).arrayBuffer);
    if (bytes.byteLength !== attachment.sizeBytes) return null;
    const result = yield* runAttachmentUploadCycle({
      registry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId: to,
      upload,
      resolveUploadUrl: (relativeUrl) => {
        const local = readPreparedConnection(to);
        return local === null ? null : resolveAssetUrl(local.httpBaseUrl, relativeUrl);
      },
      transport: (uploadUrl) =>
        http
          .execute(
            HttpClientRequest.post(uploadUrl).pipe(
              HttpClientRequest.bodyUint8Array(bytes, upload.mimeType),
            ),
          )
          .pipe(Effect.asVoid),
    });
    if (result.status === "uploaded") {
      return { ...attachment, id: ChatAttachmentId.make(result.attachmentId) };
    }
    if (result.attachmentId !== null) {
      deletePendingAttachmentUpload({
        registry,
        remove: attachmentEnvironment.remove,
        environmentId: to,
        attachmentId: result.attachmentId,
      });
    }
    return null;
  }, Effect.timeout(COPY_TIMEOUT));
