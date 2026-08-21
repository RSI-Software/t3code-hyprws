import { createFileRoute } from "@tanstack/react-router";

import { ChatThreadRouteView } from "./_chat.$environmentId.$threadId";

export const Route = createFileRoute("/project/$environmentId/$projectId/thread/$threadId")({
  component: ChatThreadRouteView,
});
