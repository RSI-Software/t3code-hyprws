// @effect-diagnostics nodeBuiltinImport:off - The sync driver runs this resolver before any Effect runtime exists.

// The license-list resolver the sync's stop loop runs on a conflicted
// `third-party-licenses.config.json` (RSI-Software/t3code-hyprws#1488).
//
// The config is authored input: `vp run licenses:sync` reads it and never
// reproduces it, so no generator can rebuild a conflicted copy. Both sides
// append entries to the same arrays instead, which is a union keyed on each
// entry's `name`. Every array keeps upstream's order, then the fork's
// additions in the fork's order. A name both sides changed, a delete of an
// entry the other side changed, or an entry without a unique `name` refuses.

import * as NodeUtil from "node:util";

export type LicenseMerge = { readonly text: string } | { readonly refuseReason: string };

type Json = unknown;

class Refusal extends Error {}

/** Three-way pick: the side that moved off the base wins; both moving apart refuses. */
const pick = (base: Json, upstream: Json, fork: Json, what: string): Json => {
  if (NodeUtil.isDeepStrictEqual(upstream, fork)) return upstream;
  if (NodeUtil.isDeepStrictEqual(fork, base)) return upstream;
  if (NodeUtil.isDeepStrictEqual(upstream, base)) return fork;
  throw new Refusal(`both sides changed ${what}`);
};

const byName = (entries: ReadonlyArray<Json>, key: string): Map<string, Json> => {
  const named = new Map<string, Json>();
  for (const entry of entries) {
    const name = (entry as { readonly name?: unknown } | null)?.name;
    if (typeof name !== "string") throw new Refusal(`a ${key} entry has no string name`);
    if (named.has(name)) throw new Refusal(`${key} names "${name}" twice`);
    named.set(name, entry);
  }
  return named;
};

const mergeEntries = (
  key: string,
  base: ReadonlyArray<Json>,
  upstream: ReadonlyArray<Json>,
  fork: ReadonlyArray<Json>,
): ReadonlyArray<Json> => {
  const baseByName = byName(base, key);
  const upstreamByName = byName(upstream, key);
  const forkByName = byName(fork, key);
  const merged: Json[] = [];
  const resolve = (name: string): void => {
    const what = `${key} entry "${name}"`;
    const inBase = baseByName.has(name);
    const inUpstream = upstreamByName.has(name);
    const inFork = forkByName.has(name);
    if (inUpstream && inFork) {
      merged.push(pick(baseByName.get(name), upstreamByName.get(name), forkByName.get(name), what));
      return;
    }
    // One side dropped a base entry: the drop stands only when the other side left it alone.
    if (inBase) {
      const kept = inUpstream ? upstreamByName.get(name) : forkByName.get(name);
      if (!NodeUtil.isDeepStrictEqual(kept, baseByName.get(name)))
        throw new Refusal(`one side deleted ${what} the other changed`);
      return;
    }
    merged.push(inUpstream ? upstreamByName.get(name) : forkByName.get(name));
  };
  for (const name of upstreamByName.keys()) resolve(name);
  for (const name of forkByName.keys()) if (!upstreamByName.has(name)) resolve(name);
  return merged;
};

const parse = (text: string | null, side: string): Record<string, Json> => {
  if (text === null) throw new Refusal(`the ${side} side deleted the file`);
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Refusal(`the ${side} side is not a JSON object`);
  return value as Record<string, Json>;
};

/**
 * Merge the three stages of a conflicted license list. `base` is `null` when
 * both sides added the file. The text is `JSON.stringify` output; the caller
 * formats it.
 */
export const mergeLicenseLists = (stages: {
  readonly base: string | null;
  readonly upstream: string | null;
  readonly fork: string | null;
}): LicenseMerge => {
  try {
    const base = stages.base === null ? {} : parse(stages.base, "base");
    const upstream = parse(stages.upstream, "upstream");
    const fork = parse(stages.fork, "fork");
    const keys = [
      ...Object.keys(upstream),
      ...Object.keys(fork).filter((key) => !(key in upstream)),
    ];
    const merged: Record<string, Json> = {};
    for (const key of keys) {
      const sides = [base[key] ?? [], upstream[key] ?? [], fork[key] ?? []];
      merged[key] = sides.every(Array.isArray)
        ? mergeEntries(key, sides[0] as Json[], sides[1] as Json[], sides[2] as Json[])
        : pick(base[key], upstream[key], fork[key], `"${key}"`);
    }
    return { text: `${JSON.stringify(merged, null, 2)}\n` };
  } catch (error) {
    if (error instanceof Refusal || error instanceof SyntaxError)
      return { refuseReason: error.message };
    throw error;
  }
};
