import { Spinner } from "~/components/ui/spinner";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { CircleAlertIcon, CircleCheckIcon, DownloadIcon } from "lucide-react";

export function ComposerServerUpdateIcon({
  status,
}: {
  readonly status: ServerUpdateState["status"];
}) {
  if (status === "running") {
    return <Spinner aria-hidden />;
  }
  if (status === "failed") {
    return <CircleAlertIcon aria-hidden className="text-error" />;
  }
  if (status === "completed") return <CircleCheckIcon aria-hidden />;
  return <DownloadIcon aria-hidden />;
}
