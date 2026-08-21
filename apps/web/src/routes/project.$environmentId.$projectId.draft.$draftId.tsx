import { createFileRoute } from "@tanstack/react-router";

import { DraftChatThreadRouteView } from "./_chat.draft.$draftId";

export const Route = createFileRoute("/project/$environmentId/$projectId/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
