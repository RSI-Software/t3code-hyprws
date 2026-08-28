import { IMAGE_EXTENSION_BY_MIME_TYPE, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const VIDEO_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

export const SAFE_ATTACHMENT_FILE_EXTENSIONS = new Set([
  ...SAFE_IMAGE_FILE_EXTENSIONS,
  ...Object.values(VIDEO_EXTENSION_BY_MIME_TYPE),
  ".bin",
]);

/** The staged suffix is derived from the validated MIME type, never from an arbitrary path. */
export function inferAttachmentExtension(input: {
  readonly mimeType: string;
  readonly fileName?: string;
}): string {
  const mimeType = input.mimeType.toLowerCase();
  const fromMime = IMAGE_EXTENSION_BY_MIME_TYPE[mimeType] ?? VIDEO_EXTENSION_BY_MIME_TYPE[mimeType];
  if (fromMime) return fromMime;

  const match = /\.([a-z0-9]{1,8})$/i.exec(input.fileName?.trim() ?? "");
  const fromName = match ? `.${match[1]!.toLowerCase()}` : "";
  return SAFE_ATTACHMENT_FILE_EXTENSIONS.has(fromName) ? fromName : ".bin";
}
