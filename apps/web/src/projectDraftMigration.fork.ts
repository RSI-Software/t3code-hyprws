// One-way migration for composer drafts saved under the retired project routes
// (RSI-Software/t3code-hyprws#1347).
//
// A window opened on `#/project/<env>/<project>/…` persisted its drafts under
// `<key>:project:<env>:<project>`, and its per-window bucket under that name plus
// `:window:<token>`. Those routes now redirect to ordinary ones, so the store only
// reads `<key>`. Before it hydrates, each project bucket folds into its route-free
// counterpart: the shared bucket into `<key>`, a window bucket into
// `<key>:window:<token>`, where the window draft scope finds and adopts it.
// Existing entries win and sources only fill gaps, so no draft text is dropped.
// The destination is written before a source is removed.

type StringStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

interface Bucket {
  readonly state: Record<string, unknown>;
  readonly version?: number | undefined;
  readonly touchedAt?: number | undefined;
}

const MERGED_MAPS = [
  "draftsByThreadKey",
  "draftThreadsByThreadKey",
  "logicalProjectDraftThreadKeyByLogicalProjectKey",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readBucket(storage: StringStorage, key: string): Bucket | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.state)) return null;
    return {
      state: parsed.state,
      version: typeof parsed.version === "number" ? parsed.version : undefined,
      touchedAt: typeof parsed.touchedAt === "number" ? parsed.touchedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** The route-free key a project-scoped draft key folds into, or null for any other key. */
export function projectDraftDestinationKey(name: string, key: string): string | null {
  const prefix = `${name}:project:`;
  if (!key.startsWith(prefix)) return null;
  const windowAt = key.indexOf(":window:", prefix.length);
  return windowAt === -1 ? name : `${name}${key.slice(windowAt)}`;
}

// The destination wins every entry it already has; the older version wins, so the
// store's own `migrate` still sees legacy entries.
function mergeBuckets(destination: Bucket | null, source: Bucket): Bucket {
  const state: Record<string, unknown> = { ...source.state, ...destination?.state };
  for (const field of MERGED_MAPS) {
    const from = source.state[field];
    const into = destination?.state[field];
    state[field] = { ...(isRecord(from) ? from : {}), ...(isRecord(into) ? into : {}) };
  }
  const versions = [destination?.version, source.version].filter(
    (version): version is number => version !== undefined,
  );
  const touched = [destination?.touchedAt, source.touchedAt].filter(
    (touchedAt): touchedAt is number => touchedAt !== undefined,
  );
  return {
    state,
    ...(versions.length > 0 ? { version: Math.min(...versions) } : {}),
    ...(touched.length > 0 ? { touchedAt: Math.max(...touched) } : {}),
  };
}

/** Folds every project-scoped draft bucket under `name` into its route-free bucket. */
export function migrateProjectDraftBuckets(storage: StringStorage, name: string): void {
  const sources: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && projectDraftDestinationKey(name, key) !== null) sources.push(key);
  }
  for (const key of sources.toSorted()) {
    const destinationKey = projectDraftDestinationKey(name, key);
    const source = readBucket(storage, key);
    // An unreadable source stays put rather than being dropped.
    if (destinationKey === null || source === null) continue;
    try {
      const merged = mergeBuckets(readBucket(storage, destinationKey), source);
      storage.setItem(destinationKey, JSON.stringify(merged));
      storage.removeItem(key);
    } catch {
      // A failed write (quota, denied storage) leaves the source for the next start.
    }
  }
}

/** Runs the migration against the browser's localStorage; a no-op outside a browser. */
export function migrateProjectDraftBucketsInBrowser(name: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    migrateProjectDraftBuckets(window.localStorage, name);
  } catch {
    // Denied storage: upstream persistence stands untouched.
  }
}
