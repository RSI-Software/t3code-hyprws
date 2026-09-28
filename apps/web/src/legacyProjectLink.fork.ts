// Old project-window links (RSI-Software/t3code-hyprws#1347). The project
// route family is gone; a `/project/<environment>/<project>/…` link, whether
// typed, bookmarked, deep-linked, or restored from a window manifest as a hash
// route, lands on the ordinary route it meant. Stateless: it reads only the
// link, never the window or its filter.

type LegacySearch = Readonly<Record<string, unknown>>;

export type LegacyProjectLinkTarget =
  | { readonly to: "/" }
  | {
      readonly to: "/$environmentId/$threadId";
      readonly params: { readonly environmentId: string; readonly threadId: string };
    }
  | { readonly to: "/draft/$draftId"; readonly params: { readonly draftId: string } }
  | { readonly to: "/issues" | "/pull-requests"; readonly search: LegacySearch };

const HOME: LegacyProjectLinkTarget = { to: "/" };

const decodeSegment = (segment: string | undefined): string | null => {
  if (segment === undefined) return null;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape is kept as written; it names nothing the app can resolve anyway.
  }
  return decoded.length > 0 && decoded.trim() === decoded ? decoded : null;
};

/**
 * The ordinary route an old project link meant. `pathname` is the router path
 * (`/project/…`, or `#/project/…` as a hash route); `search` is its parsed
 * query. Anything malformed lands home.
 */
export function decodeLegacyProjectLink(
  pathname: string,
  search: LegacySearch = {},
): LegacyProjectLinkTarget {
  const path = pathname.replace(/^\/?#/, "");
  const [empty, family, environment, project, kind, id, ...rest] = path.split("/");
  if (empty !== "" || family !== "project") return HOME;
  const environmentId = decodeSegment(environment);
  const projectId = decodeSegment(project);
  if (environmentId === null || projectId === null) return HOME;
  const tail = rest.filter((segment) => segment.length > 0);
  if (tail.length > 0) return HOME;
  switch (kind) {
    case undefined:
      return HOME;
    case "thread": {
      const threadId = decodeSegment(id);
      return threadId === null
        ? HOME
        : { to: "/$environmentId/$threadId", params: { environmentId, threadId } };
    }
    case "draft": {
      const draftId = decodeSegment(id);
      return draftId === null ? HOME : { to: "/draft/$draftId", params: { draftId } };
    }
    case "issues":
    case "pull-requests": {
      if (id !== undefined && id !== "") return HOME;
      const { scope, ...kept } = search;
      // The project page listed its own project unless `scope=all` widened it,
      // where any project the link names is an explicit filter and stays.
      return {
        to: kind === "issues" ? "/issues" : "/pull-requests",
        search: scope === "all" ? kept : { ...kept, projectId, environmentId },
      };
    }
    default:
      return HOME;
  }
}
