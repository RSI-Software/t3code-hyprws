// @effect-diagnostics nodeBuiltinImport:off - Electron static protocol handlers require synchronous platform path validation.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Electron from "electron";

import { DESKTOP_HOST } from "./ElectronProtocol.ts";

/**
 * A client-only packaged launch has no backend of its own to proxy, so its scheme serves the
 * renderer straight off disk. Upstream's registration input describes the proxy case only, and
 * this fork-owned shape sits beside it rather than replacing it.
 */
export interface DesktopStaticProtocolRegistrationInput {
  readonly scheme: string;
  readonly staticRoot: string;
  readonly clerkFrontendApiHostname: string | undefined;
}

export const isDesktopStaticProtocolRegistration = (
  input: { readonly scheme: string } | DesktopStaticProtocolRegistrationInput,
): input is DesktopStaticProtocolRegistrationInput => "staticRoot" in input;

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type StaticPathResolution =
  | { readonly _tag: "Invalid"; readonly status: 400 | 403 }
  | { readonly _tag: "Resolved"; readonly path: string; readonly relativePath: string };

function resolveDesktopStaticPath(
  staticRoot: string,
  encodedPathname: string,
): StaticPathResolution {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(encodedPathname);
  } catch {
    return { _tag: "Invalid", status: 400 };
  }

  if (
    decodedPathname.includes("\0") ||
    decodedPathname.includes("\\") ||
    /^[a-zA-Z]:/u.test(decodedPathname.replace(/^\/+/u, ""))
  ) {
    return { _tag: "Invalid", status: 403 };
  }

  const segments = decodedPathname.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { _tag: "Invalid", status: 403 };
  }

  const relativePath = segments.length === 0 ? "index.html" : segments.join("/");
  const normalizedRoot = NodePath.resolve(staticRoot);
  const resolvedPath = NodePath.resolve(normalizedRoot, relativePath);
  const relativeToRoot = NodePath.relative(normalizedRoot, resolvedPath);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relativeToRoot)
  ) {
    return { _tag: "Invalid", status: 403 };
  }

  return {
    _tag: "Resolved",
    path: resolvedPath,
    relativePath,
  };
}

function shouldUseSpaFallback(request: Request, relativePath: string): boolean {
  if (NodePath.extname(relativePath) !== "") {
    return false;
  }
  const accept = request.headers.get("accept") ?? "";
  const mode = request.headers.get("sec-fetch-mode") ?? "";
  return mode === "navigate" || accept.includes("text/html");
}

async function fetchStaticFile(path: string): Promise<Response> {
  try {
    return await Electron.net.fetch(NodeURL.pathToFileURL(path).href, { method: "GET" });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function withStaticResponseHeaders(response: Response, path: string, headOnly: boolean): Response {
  const headers = new Headers(response.headers);
  const contentType = STATIC_CONTENT_TYPES[NodePath.extname(path).toLowerCase()];
  if (contentType !== undefined) {
    headers.set("Content-Type", contentType);
  }
  return new Response(headOnly ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Serves one packaged-renderer request. The caller owns the response policy, so this returns the
 * body and its content type only.
 */
export async function serveDesktopStaticRequest(
  request: Request,
  staticRoot: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const resolution = resolveDesktopStaticPath(staticRoot, requestUrl.pathname);
  if (resolution._tag === "Invalid") {
    return new Response(null, { status: resolution.status });
  }

  let response = await fetchStaticFile(resolution.path);
  let responsePath = resolution.path;
  if (response.status === 404 && shouldUseSpaFallback(request, resolution.relativePath)) {
    // Resolve the shell through the same normalization as asset paths so a
    // relative or non-normalized staticRoot still falls back correctly.
    responsePath = NodePath.resolve(staticRoot, "index.html");
    response = await fetchStaticFile(responsePath);
  }

  return withStaticResponseHeaders(response, responsePath, request.method === "HEAD");
}
