import { ArrowLeftIcon } from "lucide-react";
import { createContext, useContext } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface CrumbsSubject {
  readonly singular: string;
  readonly plural: string;
}

const CrumbsSubjectContext = createContext<CrumbsSubject | null>(null);

/** Names what the crumbs lead to when they head something other than a pull request. */
export const CrumbsSubjectForkProvider = CrumbsSubjectContext;

export const useCrumbsSubjectFork = (): CrumbsSubject | null => useContext(CrumbsSubjectContext);

export const crumbsNumberLabelFork = (subject: CrumbsSubject | null, number: number) =>
  subject === null ? {} : { "aria-label": `Open ${subject.singular} #${number} on host` };

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
