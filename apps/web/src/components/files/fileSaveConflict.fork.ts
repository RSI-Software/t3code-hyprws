import {
  type EnvironmentId,
  ProjectWriteFileError,
  type ProjectWriteFileInput,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import type { RefObject } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import {
  fileSaveBase,
  isReloadedFileSave,
  markFileSaveReloaded,
  rebaseFileSave,
} from "./fileSaveBase.fork";
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
const conflictToasts = new Map<object, ReturnType<typeof toastManager.add>>();

function closeConflict(file: object): void {
  const toastId = conflictToasts.get(file);
  if (toastId === undefined) return;
  conflictToasts.delete(file);
  toastManager.close(toastId);
}

/** Sends each save with its draft's base revision and prompts when the server refuses it. */
export function withStaleWriteGuard<A, E>(
  writeFile: FileWrite<A, E>,
  coordinator: RefObject<FileSaveCoordinator | null>,
): FileWrite<A, E> {
  const guarded: FileWrite<A, E> = async ({ environmentId, input }) => {
    const { cwd, relativePath } = input;
    const file = optimisticFileAtom(environmentId, cwd, relativePath);
    const expectedRevision = fileSaveBase(file);
    if (isReloadedFileSave(expectedRevision)) {
      // The user dropped this draft with Reload; this editor never got the news.
      coordinator.current?.discard();
      return AsyncResult.failure(Cause.interrupt());
    }
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
    if (!isProjectWriteFileError(error) || error.failure !== "contents_changed") return result;

    const overwrite = () => {
      closeConflict(file);
      rebaseFileSave(file, undefined);
      const draft = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
      if (!draft) return;
      if (coordinator.current) {
        coordinator.current.change(draft.contents);
        return;
      }
      // The panel closed with the draft unsaved; write it without a session.
      void guarded({ environmentId, input: { cwd, relativePath, contents: draft.contents } }).then(
        (written) => {
          if (written._tag === "Success")
            confirmProjectFileQueryData(environmentId, cwd, relativePath, draft.contents);
        },
      );
    };
    const reload = () => {
      closeConflict(file);
      coordinator.current?.discard();
      clearProjectFileQueryData(environmentId, cwd, relativePath);
      markFileSaveReloaded(file);
      appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, relativePath));
    };
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
      return result;
    }
    // A dismissed prompt must not block the next one.
    const toastId = toastManager.add({
      ...options,
      onRemove: () => {
        if (conflictToasts.get(file) === toastId) conflictToasts.delete(file);
      },
    });
    conflictToasts.set(file, toastId);
    return result;
  };
  return guarded;
}
