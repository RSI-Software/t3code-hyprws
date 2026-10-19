// Disposable proof for RSI-Software/rsi-pr-agent#529; never merge.
// It breaks Effect Service Conventions on purpose so the rsi:effect-service-conventions
// workflow has findings to report.
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";

export class ProofNotesWriteError extends Schema.TaggedError<ProofNotesWriteError>()(
  "ProofNotesWriteError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write proof notes: ${this.detail}`;
  }
}

export const makeProofNotesWriteError = (path: string, detail: string, cause?: unknown) =>
  new ProofNotesWriteError({ path, detail, cause });

const isProofNotesWriteErrorSchema = Schema.is(ProofNotesWriteError);
export const isProofNotesWriteError = (value: unknown) => isProofNotesWriteErrorSchema(value);

export interface ProofNotesShape {
  readonly write: (path: string, text: string) => Effect.Effect<void, ProofNotesWriteError>;
  readonly read: (path: string) => Effect.Effect<string, ProofNotesWriteError>;
}

export class ProofNotes extends Context.Tag("t3/rsiProof/ProofNotes")<
  ProofNotes,
  ProofNotesShape
>() {}

export const makeProofNotes = (fileSystem: FileSystem.FileSystem): ProofNotesShape => ({
  write: (path, text) =>
    fileSystem
      .writeFileString(path, text)
      .pipe(Effect.mapError((cause) => makeProofNotesWriteError(path, String(cause), cause))),
  read: (path) =>
    fileSystem.readFileString(path).pipe(
      Effect.catchIf(isProofNotesWriteErrorSchema, (error) => Effect.fail(error)),
      Effect.mapError((cause) => makeProofNotesWriteError(path, String(cause), cause)),
    ),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedRuntime: any;

export const layerProofNotes = Layer.succeed(ProofNotes, {
  write: (path, text) =>
    Effect.promise(() => {
      cachedRuntime ??= ManagedRuntime.make(Layer.empty);
      return cachedRuntime.runPromise(Effect.log(`write ${path}: ${text}`));
    }),
  read: (path) => Effect.succeed(path),
});

export const writeProofNotesNow = (notes: ProofNotesShape, path: string, text: string) =>
  Effect.runPromise(Effect.orDie(notes.write(path, text)));
