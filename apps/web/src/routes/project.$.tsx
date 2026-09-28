import { createFileRoute, redirect } from "@tanstack/react-router";

import { decodeLegacyProjectLink } from "../legacyProjectLink.fork";

// Old project-window links land on the ordinary route they meant.
export const Route = createFileRoute("/project/$")({
  beforeLoad: ({ location }) => {
    throw redirect({
      ...decodeLegacyProjectLink(location.pathname, location.search as Record<string, unknown>),
      replace: true,
    } as never);
  },
});
