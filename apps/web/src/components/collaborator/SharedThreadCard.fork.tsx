// Fork-only (colleague-collab): a thread a colleague shared with me says so on its sidebar card.
// The sharer is the saved colleague whose environment the thread lives on; a team thread says so instead.
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { UsersIcon } from "lucide-react";

import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuerySelector } from "~/state/query";
import { colleaguesAtom, colleaguesServedFork } from "./colleagues.fork";

export const SHARED_THREAD_CARD_CLASS_FORK =
  "before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:rounded-full before:bg-primary/70";

/** Who shared each environment's threads: the colleagues saved on this app's own server. */
export function useSharerNamesFork() {
  const primary = usePrimaryEnvironmentId();
  const served = colleaguesServedFork(useServerConfigs(), primary);
  const colleagues = useEnvironmentQuerySelector(
    served && primary !== null ? colleaguesAtom(primary) : null,
    selectEnvironmentQueryData,
  );
  return new Map(
    (colleagues ?? []).map((colleague) => [colleague.environmentId, colleague.name] as const),
  );
}

/** Who shared a card's thread: the saved colleague on its environment, or null for a one-time
 * guest copy. A thread in their team project says so instead, from the project's mark. */
export type SharedCardFork = { readonly name: string | null; readonly team: boolean };

/** One read for the whole list. A shared thread's card names its sharer in place of the machine. */
export function useSharedCardPropsFork() {
  const nameByEnvironment = useSharerNamesFork();
  return (
    thread: {
      readonly environmentId: EnvironmentId;
      readonly collaboratorFork?: string | undefined;
    },
    project: { readonly teamFork?: boolean | undefined } | undefined,
  ) =>
    thread.collaboratorFork === undefined
      ? {}
      : {
          sharedByFork: {
            name: nameByEnvironment.get(thread.environmentId) ?? null,
            team: project?.teamFork === true,
          } satisfies SharedCardFork,
          environmentLabel: null,
        };
}

/** The card's accessible name stays the title; this describes it, so focus also says who shared it. */
export const sharedByIdFork = (threadKey: string) => `sidebar-shared-by-${threadKey}`;

export function SharedByFork({
  id,
  share,
}: {
  readonly id: string;
  readonly share: SharedCardFork;
}) {
  const gt = useGT();
  const { name, team } = share;
  return (
    <>
      <UsersIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
      <span id={id} className="min-w-0 truncate font-medium text-primary">
        {team ? (
          gt("Team project")
        ) : name === null ? (
          <T>Shared with you</T>
        ) : (
          <T>
            Shared by <Var>{name}</Var>
          </T>
        )}
      </span>
    </>
  );
}
