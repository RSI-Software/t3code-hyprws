import {
  PULL_REQUEST_ATTACHMENT_MAX_BYTES,
  PULL_REQUEST_ATTACHMENT_MIME_TYPES,
  type EnvironmentId,
  type PullRequestAttachmentMimeType,
  type PullRequestRef,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachmentEnvironment } from "../state/attachments";
import { pullRequestEnvironment } from "../state/pullRequests";
import { formatEnvironmentQueryError } from "../state/query";
import { uploadFileBytes } from "./uploadFileBytes";

const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, PullRequestAttachmentMimeType>> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export function pullRequestAttachmentMimeType(file: Pick<File, "name" | "type">) {
  const declared = file.type.trim().toLowerCase();
  const supported = PULL_REQUEST_ATTACHMENT_MIME_TYPES.find((mimeType) => mimeType === declared);
  if (supported) return supported;
  const extension = /\.[a-z0-9]+$/i.exec(file.name.trim())?.[0]?.toLowerCase();
  return extension ? MIME_TYPE_BY_EXTENSION[extension] : undefined;
}

export async function uploadPullRequestAttachment(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly httpBaseUrl: string;
  readonly file: File;
  readonly onProgress: (progress: number) => void;
  /** Staging is done and the environment is publishing to the host, which nothing can cancel. */
  readonly onPublish?: () => void;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const mimeType = pullRequestAttachmentMimeType(input.file);
  if (!mimeType) throw new Error("Choose a PNG, GIF, JPEG, SVG, MP4, MOV, or WebM file.");
  if (input.file.size < 1 || input.file.size > PULL_REQUEST_ATTACHMENT_MAX_BYTES) {
    throw new Error("Attachments must be no larger than 10 MB.");
  }

  const minted = await runAtomCommand(
    appAtomRegistry,
    pullRequestEnvironment.createAttachmentUploadUrl,
    {
      environmentId: input.environmentId,
      input: {
        ...input.reference,
        name: input.file.name,
        mimeType,
        sizeBytes: input.file.size,
      },
    },
    { reportFailure: false },
  );
  if (minted._tag === "Failure") {
    throw new Error(formatEnvironmentQueryError(minted.cause));
  }

  try {
    const url = resolveAssetUrl(input.httpBaseUrl, minted.value.relativeUrl);
    if (!url) throw new Error("The attachment upload URL is invalid.");

    const staged = uploadFileBytes({
      url,
      file: input.file,
      contentType: mimeType,
      onProgress: input.onProgress,
    });
    const abort = () => staged.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) staged.abort();
    try {
      await staged.done;
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
    if (input.signal?.aborted) throw new Error("Upload cancelled");
    input.onPublish?.();
    const published = await runAtomCommand(
      appAtomRegistry,
      pullRequestEnvironment.uploadAttachment,
      {
        environmentId: input.environmentId,
        input: {
          ...input.reference,
          attachmentId: minted.value.attachmentId,
          name: input.file.name,
          mimeType,
        },
      },
      { reportFailure: false },
    );
    if (published._tag === "Failure") {
      throw new Error(formatEnvironmentQueryError(published.cause));
    }
    return published.value.insertion;
  } finally {
    void runAtomCommand(
      appAtomRegistry,
      attachmentEnvironment.remove,
      { environmentId: input.environmentId, input: { attachmentId: minted.value.attachmentId } },
      { reportFailure: false, reportDefect: false },
    );
  }
}
