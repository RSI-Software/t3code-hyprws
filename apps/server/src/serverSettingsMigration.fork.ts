import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));

export const migrateLegacySettingsJsonFork = (migrate: (settings: unknown) => unknown) =>
  Effect.map((raw: string) => {
    const parsed = decodeJson(raw);
    if (parsed._tag === "Failure") return raw;
    // Migrate before the upstream schema drops retired keys; leave invalid JSON for its error path.
    const migrated = migrate(parsed.value);
    return migrated === parsed.value ? raw : JSON.stringify(migrated);
  });
