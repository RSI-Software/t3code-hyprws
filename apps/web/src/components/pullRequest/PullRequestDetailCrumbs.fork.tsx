import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { createContext, useContext } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";

interface CrumbsSubject {
  readonly singular: string;
  readonly plural: string;
  /** The number as its tracker writes it, such as Linear's `ENG-42`; `#42` otherwise. */
  readonly numberText?: string;
}

const CrumbsSubjectContext = createContext<CrumbsSubject | null>(null);

/** Names what the crumbs lead to when they head something other than a pull request. */
export const CrumbsSubjectForkProvider = CrumbsSubjectContext;

export const useCrumbsSubjectFork = (): CrumbsSubject | null => useContext(CrumbsSubjectContext);

export const crumbsNumberLabelFork = (subject: CrumbsSubject | null, number: number) =>
  subject === null ? {} : { "aria-label": `Open ${subject.singular} #${number} on host` };

/** The number link for a tracker that writes its own numbers, such as Linear's `ENG-42`. */
export function CrumbsNumberTextLinkFork({
  forkSubject,
  detail,
  toneClassName,
  openOnHostText,
  focusable,
}: {
  readonly forkSubject: CrumbsSubject;
  readonly detail: { readonly url: string };
  readonly toneClassName: string;
  readonly openOnHostText: string;
  readonly focusable: boolean;
}) {
  const open = () => void readLocalApi()?.shell.openExternal(detail.url);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InlineButton
            {...(focusable ? {} : { tabIndex: -1 })}
            onClick={open}
            onAuxClick={(event) => {
              if (event.button === 1) open();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void showPullRequestLinkContextMenu({
                url: detail.url,
                openLabel: openOnHostText,
                position: { x: event.clientX, y: event.clientY },
              });
            }}
            aria-label={`Open ${forkSubject.singular} ${forkSubject.numberText} on host`}
          >
            <span className={toneClassName}>{forkSubject.numberText}</span>
            <ExternalLinkIcon aria-hidden className={cn("size-2.5", toneClassName)} />
          </InlineButton>
        }
      />
      <TooltipPopup side="top">{openOnHostText}</TooltipPopup>
    </Tooltip>
  );
}

export function CrumbsBackButtonFork({
  onBack,
  focusable,
  subject,
}: {
  readonly onBack: () => void;
  readonly focusable: boolean;
  readonly subject: CrumbsSubject;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            {...(focusable ? {} : { tabIndex: -1 })}
            onClick={onBack}
            className="-ml-1.5"
            aria-label={`Back to this thread's ${subject.plural}`}
          >
            <ArrowLeftIcon aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top">Back to {subject.plural}</TooltipPopup>
    </Tooltip>
  );
}
