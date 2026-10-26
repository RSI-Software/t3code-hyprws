import {
  type EnvironmentId,
  ProjectWriteFileError,
  type ProjectWriteFileInput,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import type { RefObject } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import { fileSaveBase, rebaseFileSave } from "./fileSaveBase.fork";
import type { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  getProjectFileQueryAtom,
  optimisticFileAtom,
} from "./projectFilesQueryState";

// Stale-write prompt (RSI-Software/t3code-hyprws#1761). A refused save keeps
// the draft pending and asks once per file; the coordinator does not retry a
// failed save on its own, so nothing is written until the user picks.
interface FileWriteRequest {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectWriteFileInput;
}
type FileWrite<A, E> = (request: FileWriteRequest) => Promise<AtomCommandResult<A, E>>;

const isProjectWriteFileError = Schema.is(ProjectWriteFileError);
type Session = RefObject<FileSaveCoordinator | null>;
const conflictToasts = new Map<object, ReturnType<typeof toastManager.add>>();
// Every editor session of a file, so a prompt raised by one panel still acts
// on the panel that replaced it.
const fileSessions = new Map<object, Set<Session>>();

function liveCoordinators(file: object): FileSaveCoordinator[] {
  const live: FileSaveCoordinator[] = [];
  for (const session of fileSessions.get(file) ?? []) {
    if (session.current) live.push(session.current);
    else fileSessions.get(file)?.delete(session);
  }
  return live;
}

function closeConflict(file: object): void {
  const toastId = conflictToasts.get(file);
  if (toastId === undefined) return;
  conflictToasts.delete(file);
  toastManager.close(toastId);
}

/** Sends each save with its draft's base revision and prompts when the server refuses it. */
export function withStaleWriteGuard<A, E>(
  writeFile: FileWrite<A, E>,
  session: Session,
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): FileWrite<A, E> {
  const file = optimisticFileAtom(environmentId, cwd, relativePath);
  const sessions = fileSessions.get(file) ?? new Set();
  fileSessions.set(file, sessions.add(session));

  const writeDraft = async (input: ProjectWriteFileInput) => {
    const expectedRevision = fileSaveBase(file);
    const result = await writeFile({
      environmentId,
      input: expectedRevision === undefined ? input : { ...input, expectedRevision },
    });
    if (result._tag === "Success") {
      rebaseFileSave(file, input.contents);
      closeConflict(file);
      return result;
    }
    const error = squashAtomCommandFailure(result);
    if (isProjectWriteFileError(error) && error.failure === "contents_changed") askOnConflict();
    return result;
  };

  const overwrite = () => {
    closeConflict(file);
    rebaseFileSave(file, undefined);
    const draft = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
    if (!draft) return;
    const [coordinator] = liveCoordinators(file);
    if (coordinator) {
      coordinator.change(draft.contents);
      return;
    }
    // The panel closed with the draft unsaved; write it without a session.
    void writeDraft({ cwd, relativePath, contents: draft.contents }).then((written) => {
      if (written._tag === "Success")
        confirmProjectFileQueryData(environmentId, cwd, relativePath, draft.contents);
    });
  };
  const reload = () => {
    closeConflict(file);
    for (const coordinator of liveCoordinators(file)) coordinator.discard();
    clearProjectFileQueryData(environmentId, cwd, relativePath);
    appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  };
  const askOnConflict = () => {
    const options = stackedThreadToast({
      type: "warning",
      title: `${relativePath} changed on disk`,
      description: "Your edits are not saved. Overwrite the newer version, or reload it.",
      timeout: 0,
      actionProps: { children: "Overwrite", onClick: overwrite },
      data: { hideCopyButton: true, secondaryActionProps: { children: "Reload", onClick: reload } },
    });
    const shownId = conflictToasts.get(file);
    if (shownId !== undefined) {
      toastManager.update(shownId, options);
      return;
    }
    // A dismissed prompt must not block the next one.
    const toastId = toastManager.add({
      ...options,
      onRemove: () => {
        if (conflictToasts.get(file) === toastId) conflictToasts.delete(file);
      },
    });
    conflictToasts.set(file, toastId);
  };

  return ({ input }) => writeDraft(input);
}
