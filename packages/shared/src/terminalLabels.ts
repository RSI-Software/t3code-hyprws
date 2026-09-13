import type { TerminalSummary } from "@t3tools/contracts";

function terminalNumber(terminalId: string): string | undefined {
  return /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(
    terminalId,
  )?.[1];
}

export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = terminalNumber(terminalId);
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

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
 * Suffix duplicated chip labels (`main`, `main·2`, `·3`) for terminals sharing one zmux session.
 * Numbers come from each `term-N` id, not position, so closing siblings never renumbers
 * survivors; the lowest member keeps the bare label.
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

/** Append a UUID when metadata is unavailable to avoid reusing unseen host sessions. */
export function nextTerminalId(
  existingTerminalIds: ReadonlyArray<string>,
  uniqueSuffix?: string,
): string {
  const usedNumbers = new Set(existingTerminalIds.map(terminalNumber));
  let nextIndex = 1;
  while (usedNumbers.has(String(nextIndex))) {
    nextIndex += 1;
  }

  return `term-${nextIndex}${uniqueSuffix === undefined ? "" : `-${uniqueSuffix}`}`;
}
