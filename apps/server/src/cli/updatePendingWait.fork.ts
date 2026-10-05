import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { BootService } from "../cloud/bootService.ts";
import { SERVICE_STATE_FILE, serviceStateHasPendingUpdate } from "../cloud/serviceProtocol.ts";

const POLL_INTERVAL = Duration.seconds(1);
// The launcher bounds a trial at 30 minutes; the database backup before it is unbounded.
const WAIT_LIMIT = Duration.minutes(30);

/**
 * Installing over a remote update stops the service while the launcher backs up the database.
 * systemd then SIGKILLs it after its stop timeout, leaving the update pending, and the install
 * refuses. Let a running launcher finish first; a stopped one resumes the update on its next start.
 */
export const awaitPendingServiceUpdate = Effect.fn("cli.update.await_pending_service_update")(
  function* (input: {
    readonly baseDir: string;
    readonly status: BootService["Service"]["status"];
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pending = fs.readFileString(path.join(input.baseDir, "runtime", SERVICE_STATE_FILE)).pipe(
      Effect.map(serviceStateHasPendingUpdate),
      Effect.orElseSucceed(() => false),
    );
    if (!(yield* pending)) return;
    const status = yield* input.status.pipe(Effect.option);
    if (Option.isNone(status) || status.value.problems?.includes("service-stopped")) return;
    yield* Console.log("  A server update is already in progress. Waiting for it to finish...");
    yield* Effect.sleep(POLL_INTERVAL).pipe(
      Effect.andThen(pending),
      Effect.repeat({ while: (stillPending) => stillPending }),
      Effect.timeoutOption(WAIT_LIMIT),
    );
  },
);
