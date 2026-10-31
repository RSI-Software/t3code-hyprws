// Fork-only (colleague-collab): a colleague's copy of a thread its host stopped sharing stays
// readable, with a banner and a locked composer.
import { UnplugIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";

const FROZEN_BANNER: ComposerBannerStackItem = {
  id: "colleague-frozen",
  variant: "warning",
  group: "environment",
  icon: <UnplugIcon />,
  title: "Disconnected from host",
  description: "The host stopped sharing this thread. You can still read and copy it.",
};

/** Composer overrides for a frozen colleague thread; nothing for any other thread. */
export function colleagueFrozenComposerFork(
  thread: { readonly colleagueFrozenFork?: boolean } | undefined,
  bannerItems: ReadonlyArray<ComposerBannerStackItem>,
) {
  if (thread?.colleagueFrozenFork !== true) return {};
  return {
    canOperateThread: false,
    sendDisabledReason: "The host stopped sharing this thread.",
    bannerItems: [FROZEN_BANNER, ...bannerItems],
  };
}
