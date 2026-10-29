import { imageSchema } from "@milkdown/preset-commonmark";
import { $view } from "@milkdown/utils";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";

/** Mints a URL for an absolute workspace path, or null when the file cannot be served. */
export type WorkspaceImageUrl = (path: string) => Promise<string | null>;

/**
 * A relative `src` would load against the app's own origin, so a workspace file loses it until
 * the server mints a URL. Remote and data sources stay as authored.
 */
export function resolveWorkspaceImage(
  image: HTMLImageElement,
  directory: string,
  imageUrl: WorkspaceImageUrl,
) {
  const source = classifyMarkdownImageSource(image.getAttribute("src"), directory);
  if (source._tag === "Direct") return;
  image.removeAttribute("src");
  if (source._tag !== "WorkspaceFile") return;
  void imageUrl(source.path).then((url) => {
    if (url) image.src = url;
  });
}

export function imageView(directory: () => string, imageUrl: { current: WorkspaceImageUrl }) {
  return $view(imageSchema.node, () => (node) => {
    const dom = document.createElement("img");
    dom.alt = String(node.attrs["alt"] ?? "");
    const title = String(node.attrs["title"] ?? "");
    if (title) dom.title = title;
    dom.setAttribute("src", String(node.attrs["src"] ?? ""));
    resolveWorkspaceImage(dom, directory(), imageUrl.current);
    return { dom, ignoreMutation: () => true };
  });
}
