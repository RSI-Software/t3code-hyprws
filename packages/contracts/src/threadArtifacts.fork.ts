// Fork-owned thread ↔ artifact links: documents an agent writes (trackers, plans, notes) at any
// host path. T3 stores links only and never creates or deletes the files. Changes ride the
// upstream `thread.metadata-updated` event, like linked issues, so stock clients see no new event.
import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Who created a thread ↔ artifact link. */
export const ThreadArtifactLinkSource = Schema.Literals(["manual", "agent"]);
export type ThreadArtifactLinkSource = typeof ThreadArtifactLinkSource.Type;

export const ThreadArtifactLink = Schema.Struct({
  /** Absolute host path; the link's identity within a thread. */
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  source: ThreadArtifactLinkSource,
  linkedAt: IsoDateTime,
  /** The file's last observed change: a relink or the server's file watcher. */
  updatedAt: IsoDateTime,
  /** The watcher found no file at `path`. */
  missing: Schema.Boolean,
});
export type ThreadArtifactLink = typeof ThreadArtifactLink.Type;

/**
 * The thread's `artifacts` field, omitted when a thread has none so link-free threads keep their
 * pre-feature wire shape. Readers treat a missing key as no links: `thread.artifacts ?? []`.
 */
export const ThreadArtifactLinksFieldFork = Schema.optionalKey(Schema.Array(ThreadArtifactLink));

/** Links a file, or relinks it: a relink keeps `linkedAt` and refreshes title and `updatedAt`. */
const ThreadArtifactLinkCommand = Schema.Struct({
  type: Schema.Literal("thread.artifact.link"),
  commandId: CommandId,
  threadId: ThreadId,
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  source: ThreadArtifactLinkSource,
});

const ThreadArtifactUnlinkCommand = Schema.Struct({
  type: Schema.Literal("thread.artifact.unlink"),
  commandId: CommandId,
  threadId: ThreadId,
  path: TrimmedNonEmptyString,
});

/** The file watcher's observation of a linked file. */
const ThreadArtifactObserveCommand = Schema.Struct({
  type: Schema.Literal("thread.artifact.observe"),
  commandId: CommandId,
  threadId: ThreadId,
  path: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  missing: Schema.Boolean,
});

/** Spread into both client command unions. */
export const threadArtifactClientCommandsFork = [
  ThreadArtifactLinkCommand,
  ThreadArtifactUnlinkCommand,
] as const;

/** Spread into the internal command union: only the server observes files. */
export const threadArtifactInternalCommandsFork = [ThreadArtifactObserveCommand] as const;
