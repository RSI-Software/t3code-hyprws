import { createFileRoute } from "@tanstack/react-router";

// The view lives in the project layout (see ThreadRouteView) so a draft's
// promotion to `thread/$threadId` keeps the same ChatView mounted.
export const Route = createFileRoute("/project/$environmentId/$projectId/draft/$draftId")({
  component: () => null,
});
