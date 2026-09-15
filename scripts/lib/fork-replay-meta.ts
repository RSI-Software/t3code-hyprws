// Pure start-empty replay helpers shared by the replay proofs. The walk's startup rebase runs
// `--no-keep-empty`, which drops commits that start empty (tree identical to the first parent's
// tree) at todo build, so every count and message proof that pairs with such a rebase must
// exclude the same commits on the expected side (RSI-Software/t3code-hyprws#665). Commits that
// only *become* empty during the replay are not start-empty and stay counted — their retirement
// stays a human decision.

export interface ReplayMetaRecord {
  readonly sha: string;
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly message: string;
  /** True for the boundary commits `--boundary` emits outside the range proper. */
  readonly boundary: boolean;
}

/**
 * Git arguments for the one proof-time read per range: sha, tree, parents and full message per
 * commit, in the same `--reverse --topo-order` the stored replay series was bound in. `--boundary`
 * adds the commits just outside the range, so the first commit's parent tree is in the read.
 */
export const replayMetaArguments = (from: string, to: string): ReadonlyArray<string> => [
  "log",
  "--boundary",
  "--reverse",
  "--topo-order",
  "--format=%H%x20%T%x20%P%x1f%B%x1e",
  `${from}..${to}`,
];

/** Parse one `replayMetaArguments` read. An empty read (no output) parses to no records. */
export const parseReplayMeta = (raw: string, baseSha?: string): ReadonlyArray<ReplayMetaRecord> => {
  if (raw.length === 0) return [];
  return raw.split("\x1e").flatMap((part) => {
    // Git separates entries with a newline, so the residue after the last record is whitespace.
    if (part.trim().length === 0) return [];
    const separator = part.indexOf("\x1f");
    const head = separator === -1 ? part : part.slice(0, separator);
    const message = separator === -1 ? "" : part.slice(separator + 1);
    const fields = head.split(/\s+/).filter((field) => field.length > 0);
    let sha = fields[0] ?? "";
    let boundary = false;
    if (sha.startsWith("-")) {
      boundary = true;
      sha = sha.slice(1);
    }
    // `--boundary` prints the range base with the same format (no marker on every git version),
    // so the caller names it: it is not a series record and only supplies its tree.
    if (baseSha !== undefined && sha === baseSha) boundary = true;
    return [{ sha, tree: fields[1] ?? "", parents: fields.slice(2), message, boundary }];
  });
};

/**
 * The commits a `--no-keep-empty` rebase drops: each non-boundary commit whose tree equals its
 * first parent's tree. Parent trees come from the same read — a parent inside the range is a
 * record of the read, and a parent on the range boundary arrives through `--boundary`.
 */
export const startEmptyShas = (records: ReadonlyArray<ReplayMetaRecord>): ReadonlySet<string> => {
  const trees = new Map<string, string>();
  for (const record of records)
    if (record.sha.length > 0 && record.tree.length > 0) trees.set(record.sha, record.tree);
  const empty = new Set<string>();
  for (const record of records) {
    if (record.boundary) continue;
    const parentTree = record.parents.length > 0 ? trees.get(record.parents[0]!) : undefined;
    if (parentTree !== undefined && parentTree === record.tree) empty.add(record.sha);
  }
  return empty;
};

/**
 * Drops the start-empty commits from a stored replay series (`%B%x1e` records plus a declared
 * count). The non-boundary records must align one-to-one with the stored records in order — both
 * reads use the same `--reverse --topo-order` — and when they do not, the series is returned
 * unchanged so the proof stays conservative instead of excluding the wrong records.
 */
export const excludeStartEmpty = (
  messages: string,
  declaredCount: number,
  records: ReadonlyArray<ReplayMetaRecord>,
): { readonly messages: string; readonly count: number } => {
  const empty = startEmptyShas(records);
  if (empty.size === 0) return { messages, count: declaredCount };
  const commits = records.filter(({ boundary }) => !boundary);
  const parts = messages.split("\x1e");
  const terminal = parts.pop() ?? "";
  if (parts.length === 0 || commits.length !== parts.length)
    return { messages, count: declaredCount };
  const retained = parts.filter((_, index) => !empty.has(commits[index]!.sha));
  if (retained.length === parts.length) return { messages, count: declaredCount };
  const first = retained[0];
  if (first === undefined) return { messages: "", count: declaredCount - parts.length };
  // Mirror `withoutRepairMessages`: keep every stored byte except the dropped records.
  const firstIndex = commits.findIndex(({ sha }) => !empty.has(sha));
  const firstMessage = firstIndex > 0 ? first.replace(/^\n/, "") : first;
  return {
    messages:
      [firstMessage, ...retained.slice(1).map((message) => message)].join("\x1e") +
      "\x1e" +
      terminal,
    count: declaredCount - (parts.length - retained.length),
  };
};
