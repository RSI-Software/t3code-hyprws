import { composeFilteredWindowTitle } from "@t3tools/shared/windowTitle.fork";

import { readProjectChooserHost, subscribeProjectChooserHost } from "./projectChooser.fork";

/** Decorates upstream's live thread title without competing with its subscriptions. */
export function startFilteredDocumentTitleFork(): () => void {
  let upstreamTitle = document.title;
  let writtenTitle: string | null = null;
  const apply = () => {
    if (document.title !== writtenTitle) upstreamTitle = document.title;
    writtenTitle = composeFilteredWindowTitle(
      upstreamTitle,
      readProjectChooserHost()?.titleLabel ?? null,
    );
    if (document.title !== writtenTitle) document.title = writtenTitle;
  };
  const observer = new MutationObserver(apply);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  const unsubscribe = subscribeProjectChooserHost(apply);
  apply();
  return () => {
    observer.disconnect();
    unsubscribe();
  };
}
