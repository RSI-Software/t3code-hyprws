import type { TerminalSummary } from "@t3tools/contracts";

/** Human-readable label for a terminal tab; matches mobile and web sidebars. */
export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

/** Prefer server summary label when present; otherwise fall back to `getTerminalLabel`. */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary: Pick<TerminalSummary, "label"> | null | undefined,
): string {
  const trimmed = summary?.label?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return getTerminalLabel(terminalId);
}

const TERMINAL_ID_NUMBER = /^term(?:inal)?-(\d+)$/i;

const terminalIdNumber = (terminalId: string): number | null => {
  const match = TERMINAL_ID_NUMBER.exec(terminalId);
  return match ? Number(match[1]) : null;
};

/**
 * Suffix duplicated chip labels so N terminals attached to one zmux session
 * stay distinguishable: `uat-sample/main`, `uat-sample/main·2`, `·3`, ... A
 * lone terminal keeps its unsuffixed chip.
 *
 * Numbering is anchored to the terminal's own id, not its position: the
 * lowest-numbered member of a collision group carries the base unsuffixed and
 * every other member keeps the number of its `term-N` id, so opening or
 * closing siblings never renumbers the survivors. A later terminal can
 * re-take a closed one's id slot (the allocator hands out the lowest unused
 * `term-N`), and with it that index.
 */
export function disambiguateTerminalLabels(
  labelsById: ReadonlyMap<string, string>,
): Map<string, string> {
  const idsByLabel = new Map<string, string[]>();
  for (const [terminalId, label] of labelsById) {
    const ids = idsByLabel.get(label);
    if (ids) {
      ids.push(terminalId);
    } else {
      idsByLabel.set(label, [terminalId]);
    }
  }

  const disambiguated = new Map<string, string>();
  for (const [label, ids] of idsByLabel) {
    if (ids.length === 1) {
      disambiguated.set(ids[0] ?? "", label);
      continue;
    }
    const numbers = new Map<string, number | null>(ids.map((id) => [id, terminalIdNumber(id)]));
    let anchorId = ids[0] ?? "";
    for (const id of ids) {
      const candidate = numbers.get(id) ?? null;
      const current = numbers.get(anchorId) ?? null;
      if (candidate !== null && (current === null || candidate < current)) {
        anchorId = id;
      }
    }
    const used = new Set<number>();
    const anchorNumber = numbers.get(anchorId) ?? null;
    if (anchorNumber !== null) {
      used.add(anchorNumber);
    }
    for (const id of ids) {
      if (id === anchorId) {
        disambiguated.set(id, label);
        continue;
      }
      let index = numbers.get(id) ?? null;
      if (index === null || used.has(index)) {
        index = 2;
        while (used.has(index)) {
          index += 1;
        }
      }
      used.add(index);
      disambiguated.set(id, `${label}·${String(index)}`);
    }
  }
  return disambiguated;
}

/**
 * Split a disambiguated label into the truncating base and its `·N` suffix,
 * for chip markup that must keep the suffix visible while the base shortens.
 */
export function splitTerminalLabelSuffix(label: string): { base: string; suffix: string } {
  const match = /·\d+$/.exec(label);
  if (!match) {
    return { base: label, suffix: "" };
  }
  return { base: label.slice(0, match.index), suffix: label.slice(match.index) };
}

/**
 * Client-side terminal id allocator. Ids are ALWAYS chosen by the client and sent explicitly
 * on every `terminal.open` / `terminal.attach` call — the server never allocates.
 *
 * Returns the lowest unused `term-N` id (starting at `term-1`), skipping any ids already in
 * `existingTerminalIds`.
 */
export function nextTerminalId(existingTerminalIds: ReadonlyArray<string>): string {
  const usedIds = new Set(existingTerminalIds.filter((id) => id.trim().length > 0));
  let nextIndex = 1;
  while (usedIds.has(`term-${nextIndex}`)) {
    nextIndex += 1;
  }

  return `term-${nextIndex}`;
}
