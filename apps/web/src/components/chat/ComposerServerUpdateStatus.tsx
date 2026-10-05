import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { CircleAlertIcon, CircleCheckIcon, DownloadIcon } from "lucide-react";

// Static on purpose: the title says when an update is running, and spinners repaint every frame.
export function ComposerServerUpdateIcon({
  status,
}: {
  readonly status: ServerUpdateState["status"];
}) {
  if (status === "failed") {
    return <CircleAlertIcon aria-hidden className="text-error" />;
  }
  if (status === "completed") return <CircleCheckIcon aria-hidden />;
  return <DownloadIcon aria-hidden />;
}
