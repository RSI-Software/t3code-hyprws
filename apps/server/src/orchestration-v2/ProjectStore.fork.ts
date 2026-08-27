import { ForkThreadEnvMode, ThreadEnvMode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Fork: the `projection_projects.default_thread_env_mode` column. The V1 fork
 * projection stored the exact mode, including "worktrunk", which the upstream
 * row schema rejects and so fails the whole project list. The project slot
 * only carries the wire mode; the exact mode is a project settings override,
 * so a stored "worktrunk" reads as the "worktree" it behaves like.
 */
export const ProjectRowThreadEnvModeFork = Schema.NullOr(
  ForkThreadEnvMode.pipe(
    Schema.decodeTo(
      ThreadEnvMode,
      SchemaTransformation.transform({
        decode: (mode): ThreadEnvMode => (mode === "worktrunk" ? "worktree" : mode),
        encode: (mode): ForkThreadEnvMode => mode,
      }),
    ),
  ),
);
