// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.
// Gate: none — declaration parsing; fork:scan turns refusals and undeclared contradictions into failures (fork:ci).

// The `forkSupersedes({ upstream, reason, commit })` declaration a fork test
// sibling carries beside a case that deliberately contradicts an upstream
// case (RSI-Software/t3code-hyprws#716). The upstream file is never touched,
// so the declaration is the only record of which upstream case the fork
// contradicts, why, and in which commit — and prose no tool reads is no
// record at all. This module parses declarations out of sibling text and
// judges them against the target tree's text, the way `fork-overlap.ts`
// judges a shared file: pure functions over strings, no git here.

export interface ForkSupersedesDeclaration {
  /** The upstream file path the declaration names, before the ` > `. */
  readonly upstreamPath: string;
  /** The upstream case title the declaration names, after the ` > `. */
  readonly upstreamTitle: string;
  readonly reason: string;
  readonly commit: string;
  /** 1-based line of the `forkSupersedes(` call in the sibling. */
  readonly line: number;
}

export interface ForkSupersedesRefusal {
  /** 1-based line of the offending call, or of the contradicting case. */
  readonly line: number;
  readonly detail: string;
}

export interface ForkSupersedesInput {
  /** `"<upstream path> > <test name>"`: the counterpart file and the upstream case it contradicts. */
  readonly upstream: string;
  readonly reason: string;
  readonly commit: string;
}

/**
 * Marker-only runtime for the declaration `fork:scan` reads from sibling
 * text, never by running it. A sibling imports this and calls it beside
 * the contradicting case; the call is a no-op at runtime, and the parser
 * above reads the same call out of the file's text.
 */
export const forkSupersedes = (_declaration: ForkSupersedesInput): void => {};

// `upstream: "<path> > <title>"` — the path is the sibling's counterpart
// with the `.fork` segment dropped, and the title is the upstream `it`/
// `test`/`effectIt` case the fork deliberately contradicts. The call shape
// is `forkSupersedes({ ... })` with balanced braces; a prose mention such
// as `forkSupersedes({ upstream, reason, commit })` carries no string field
// and matches nothing.
const DECLARATION_CALL = /forkSupersedes\s*\(\s*\{([^}]*)\}\s*\)/gs;
const STRING_FIELD = (name: string): RegExp =>
  new RegExp(
    `${name}\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|\`((?:\\\\.|[^\`\\\\])*)\`)`,
  );

/** Every `forkSupersedes({...})` call in one sibling's text, with raw fields. */
export const parseForkSupersedesCalls = (
  text: string,
): ReadonlyArray<{
  readonly line: number;
  readonly upstream?: string;
  readonly reason?: string;
  readonly commit?: string;
}> => {
  const calls: Array<{
    readonly line: number;
    readonly upstream?: string;
    readonly reason?: string;
    readonly commit?: string;
  }> = [];
  for (const match of text.matchAll(DECLARATION_CALL)) {
    const body = match[1] ?? "";
    // A prose mention (`forkSupersedes({ upstream, reason, commit })`)
    // carries bare identifiers, never a `name: "value"` field.
    if (!STRING_FIELD("upstream").test(body)) continue;
    const field = (name: string): string | undefined => {
      const found = STRING_FIELD(name)
        .exec(body)
        ?.slice(1)
        .find((part) => part !== undefined);
      return found === undefined ? undefined : found;
    };
    const line = text.slice(0, match.index).split("\n").length;
    const upstream = field("upstream");
    const reason = field("reason");
    const commit = field("commit");
    calls.push({
      line,
      ...(upstream === undefined ? {} : { upstream }),
      ...(reason === undefined ? {} : { reason }),
      ...(commit === undefined ? {} : { commit }),
    });
  }
  return calls;
};

// A declaration names its upstream case as `<path> > <title>`; a bare path
// or a bare title cannot identify one case in one file.
const splitUpstreamRef = (upstream: string): { path: string; title: string } | null => {
  const separator = upstream.indexOf(" > ");
  if (separator === -1) return null;
  const path = upstream.slice(0, separator).trim();
  const title = upstream.slice(separator + 3).trim();
  return path.length === 0 || title.length === 0 ? null : { path, title };
};

/**
 * A parsed declaration per well-formed call; a refusal per call missing a
 * field or carrying a malformed `upstream` ref. A declaration that names no
 * upstream case is indistinguishable from a correct one, so it is refused
 * here rather than passed through.
 */
export const collectForkSupersedes = (
  text: string,
): {
  readonly declarations: ReadonlyArray<ForkSupersedesDeclaration>;
  readonly refusals: ReadonlyArray<ForkSupersedesRefusal>;
} => {
  const declarations: Array<ForkSupersedesDeclaration> = [];
  const refusals: Array<ForkSupersedesRefusal> = [];
  for (const call of parseForkSupersedesCalls(text)) {
    const missing = ["upstream", "reason", "commit"].filter(
      (name) =>
        (name === "upstream" ? call.upstream : name === "reason" ? call.reason : call.commit) ===
        undefined,
    );
    if (missing.length > 0) {
      refusals.push({
        line: call.line,
        detail: `forkSupersedes is missing ${missing.join(", ")}; a declaration names the upstream case, why the fork differs, and the fork commit`,
      });
      continue;
    }
    const ref = splitUpstreamRef(call.upstream ?? "");
    if (ref === null) {
      refusals.push({
        line: call.line,
        detail: `forkSupersedes upstream must read "<upstream path> > <test name>"; a bare path or title names no case`,
      });
      continue;
    }
    declarations.push({
      upstreamPath: ref.path,
      upstreamTitle: ref.title,
      reason: call.reason ?? "",
      commit: call.commit ?? "",
      line: call.line,
    });
  }
  return { declarations, refusals };
};

// A case title: the first string literal of an `it`/`test`/`effectIt`
// opener, including the dotted effect forms (`it.effect`, `it.layer`).
const TITLE_OPENER =
  /^\s*(?:it|test|effectIt)\s*(?:\.[\w$]+)*\s*(?:<[^>]*>)?\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/;

/** Every case title a test file's text declares, in source order. */
export const testCaseTitles = (text: string): ReadonlyArray<string> => {
  const titles: Array<string> = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const title = TITLE_OPENER.exec(line)
      ?.slice(1)
      .find((part) => part !== undefined);
    if (title !== undefined) titles.push(title);
  }
  return titles;
};

/**
 * The 1-based lines opening a sibling test case (`it`/`test`/`effectIt`
 * with a string-literal title), in source order. A forkSupersedes call
 * belongs to the case whose opener is nearest at-or-after its own
 * line — the doc-comment convention in the tree puts the declaration
 * immediately before the case it documents. A declaration after the
 * last case opener belongs to none.
 */
export const siblingCaseOpenerLines = (text: string): ReadonlyArray<number> => {
  const openers: Array<number> = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    if (TITLE_OPENER.test(line)) openers.push(index + 1);
  }
  return openers;
};

/**
 * The upstream titles a sibling text declares as superseded for one upstream
 * path, excused one per documented sibling case. Declarations resolve to
 * the nearest case opener at-or-after their own line; each documented case
 * excuses exactly one declaration, so five declarations stacked before one
 * case excuse one deletion and a declaration after the last opener excuses
 * none (RSI-Software/t3code-hyprws#1208). Additive-only reader over
 * `collectForkSupersedes`; the parser itself is untouched.
 */
export const enclosedSupersededTitles = (text: string, path: string): ReadonlyArray<string> => {
  const openers = siblingCaseOpenerLines(text);
  const enclosed = collectForkSupersedes(text).declarations.filter(
    (declaration) =>
      declaration.upstreamPath === path && openers.some((opener) => opener >= declaration.line),
  );
  // One excusal per documented case: group the enclosed declarations by
  // their nearest opener and keep a single title each.
  const byOpener = new Map<number, string>();
  for (const declaration of enclosed) {
    const opener = Math.min(...openers.filter((line) => line >= declaration.line));
    if (!byOpener.has(opener)) byOpener.set(opener, declaration.upstreamTitle);
  }
  return [...byOpener.values()];
};

/**
 * The upstream titles a sibling text declares as superseded for one upstream
 * path, each paired with whether the declaration resolves to a documented
 * sibling case. hasReplacement is per declaration: the nearest case opener
 * at-or-after the declaration's own line must exist, or the declaration
 * sits after the last case and buys no exemption. One documented case
 * excuses one declaration — five declarations stacked before one case
 * excuse one deletion, never five (RSI-Software/t3code-hyprws#1208).
 * Additive-only reader over `collectForkSupersedes`; the parser itself is
 * untouched.
 */
export const supersededTitlesByPath = (
  text: string,
  path: string,
): ReadonlyArray<{ readonly title: string; readonly hasReplacement: boolean }> => {
  const openers = siblingCaseOpenerLines(text);
  return collectForkSupersedes(text).declarations.flatMap((declaration) =>
    declaration.upstreamPath === path
      ? [
          {
            title: declaration.upstreamTitle,
            hasReplacement: openers.some((opener) => opener >= declaration.line),
          },
        ]
      : [],
  );
};

/** The sibling titles that contradict an upstream title set — same title, different behaviour. */
export const contradictingTitles = (
  siblingTitles: ReadonlyArray<string>,
  upstreamTitles: ReadonlySet<string>,
  declaredTitles: ReadonlySet<string>,
): ReadonlyArray<string> =>
  [...new Set(siblingTitles)].filter(
    (title) => upstreamTitles.has(title) && !declaredTitles.has(title),
  );

/** A situated declaration: the sibling file it was read from. */
export interface SituatedDeclaration extends ForkSupersedesDeclaration {
  readonly sibling: string;
}

export interface SupersedesAssessment {
  /** Refusals that fail the scan: malformed calls plus declarations naming an absent file or title. */
  readonly refusals: ReadonlyArray<string>;
  /** Named upstream cases, read as superseded rather than contradictory by the additive gate. */
  readonly superseded: ReadonlyArray<{ readonly path: string; readonly title: string }>;
  /** Sibling cases contradicting an upstream case with no declaration — a finding each. */
  readonly undeclared: ReadonlyArray<{ readonly sibling: string; readonly title: string }>;
  /** Declarations whose upstream case now carries the fork behaviour — retire candidates. */
  readonly retireCandidates: ReadonlyArray<SituatedDeclaration>;
}

const openerTitle = (line: string): string | undefined =>
  TITLE_OPENER.exec(line)
    ?.slice(1)
    .find((part) => part !== undefined);

const significantLines = (text: string): Array<string> =>
  stripDeclarationCalls(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && line !== "/*",
    );

/**
 * The significant lines of the named case in a test file's text: from its
 * opener to the next case opener (or end of file). Null when no case
 * carries the title. A declaration names one upstream case, so validation
 * reads that case — never the whole file
 * (RSI-Software/t3code-hyprws#1206).
 */
const caseBodyForTitle = (text: string, title: string): ReadonlyArray<string> | null => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => openerTitle(line) === title);
  if (start === -1) return null;
  const next = lines.findIndex((line, index) => index > start && openerTitle(line) !== undefined);
  return significantLines(lines.slice(start, next === -1 ? lines.length : next).join("\n"));
};

/**
 * The significant body lines of the named case with the opener's title
 * literal stripped, so a rename that changes only the title still
 * matches by body. A body rewrite still mismatches on its own lines.
 * Null when no case carries the title.
 */
const caseBodyForRename = (text: string, title: string): ReadonlyArray<string> | null => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => openerTitle(line) === title);
  if (start === -1) return null;
  const openerStripped = lines
    .slice(start, start + 1)
    .join("\n")
    .replace(TITLE_OPENER, "");
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => openerTitle(line) !== undefined);
  return significantLines(
    [openerStripped, ...rest.slice(0, next === -1 ? rest.length : next)].join("\n"),
  );
};

/**
 * The significant lines of the sibling case a declaration documents: from
 * the nearest case opener at-or-after the declaration's own line to the
 * following opener (or end of file), reusing `siblingCaseOpenerLines` so
 * the doc-comment resolution rule stays single-sourced
 * (RSI-Software/t3code-hyprws#1208). Null when the declaration sits after
 * the last opener and documents no case.
 */
const documentedCaseBody = (text: string, line: number): ReadonlyArray<string> | null => {
  const openers = siblingCaseOpenerLines(text);
  const after = openers.filter((opener) => opener >= line);
  if (after.length === 0) return null;
  const start = Math.min(...after);
  const following = openers.filter((opener) => opener > start);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const end = following.length === 0 ? lines.length : Math.min(...following) - 1;
  return significantLines(lines.slice(start - 1, end).join("\n"));
};

// The declaration calls themselves are bookkeeping, not behaviour: the
// retire comparison reads the sibling's case body without them.
const stripDeclarationCalls = (text: string): string =>
  text.replace(/forkSupersedes\s*\(\s*\{[^}]*\}\s*\)\s*;?/gs, "");

/**
 * Every declaration in the fork siblings, judged against the upstream
 * texts. `siblings` maps a sibling path to its text; `upstreamTexts` maps
 * an upstream path to its assessed-tree text (absent when the tree no
 * longer carries the file); `baseTexts` maps an upstream path to its
 * merge-base text (absent the same way). A declaration whose upstream
 * case now carries the fork behaviour — its significant lines are a
 * subset of the upstream file's — is a retire candidate: the declaration
 * and its sibling case go in the same change. Judgement is advisory per
 * se; the caller decides what fails.
 */
export const assessForkSupersedes = (
  siblings: ReadonlyMap<string, string>,
  upstreamTexts: ReadonlyMap<string, string>,
  baseTexts: ReadonlyMap<string, string>,
): SupersedesAssessment => {
  const refusals: Array<string> = [];
  const superseded: Array<{ readonly path: string; readonly title: string }> = [];
  const undeclared: Array<{ readonly sibling: string; readonly title: string }> = [];
  const retireCandidates: Array<SituatedDeclaration> = [];

  for (const [sibling, text] of [...siblings].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const { declarations, refusals: malformed } = collectForkSupersedes(text);
    for (const refusal of malformed) refusals.push(`${sibling}:${refusal.line}: ${refusal.detail}`);
    const declaredTitles = new Set(declarations.map((declaration) => declaration.upstreamTitle));
    for (const declaration of declarations) {
      const upstreamText = upstreamTexts.get(declaration.upstreamPath);
      if (upstreamText === undefined) {
        refusals.push(
          `${sibling}:${declaration.line}: forkSupersedes names ${declaration.upstreamPath}, which the target tree does not carry`,
        );
        continue;
      }
      const titles = new Set(testCaseTitles(upstreamText));
      if (!titles.has(declaration.upstreamTitle)) {
        refusals.push(
          `${sibling}:${declaration.line}: forkSupersedes names "${declaration.upstreamTitle}", which ${declaration.upstreamPath} does not carry in the target tree; the case was renamed or removed`,
        );
        continue;
      }
      // A live divergence contradicts upstream: the named upstream case
      // must differ from the documented sibling case. When the upstream
      // body already carries the sibling case, the declaration is not a
      // live divergence — it is a retire candidate, deletion-ready with
      // its case — so it never reads as superseded on title alone
      // (RSI-Software/t3code-hyprws#1206).
      const upstreamCase = caseBodyForTitle(upstreamText, declaration.upstreamTitle);
      const siblingCase = documentedCaseBody(text, declaration.line);
      const bodyAgrees =
        upstreamCase !== null &&
        siblingCase !== null &&
        siblingCase.length > 0 &&
        siblingCase.every((line) => new Set(upstreamCase).has(line));
      if (bodyAgrees) {
        retireCandidates.push({ ...declaration, sibling });
        continue;
      }
      superseded.push({ path: declaration.upstreamPath, title: declaration.upstreamTitle });
    }
    // A sibling case that shares an upstream title contradicts it by
    // definition: same name, fork-owned behaviour. Without a declaration
    // that contradiction is unrecorded. Against the merge base, a sibling
    // title the assessed text dropped whose body the assessed text
    // carries under a new title is the rename shape: upstream's case was
    // renamed in place while the sibling still carries the base title,
    // so no shared title survives. That is undeclared too — the more
    // damaging shape, because it mutates the upstream file
    // (RSI-Software/t3code-hyprws#1206).
    // The counterpart is the sibling with the `.fork` segment dropped, so
    // a sibling contradicts only its own upstream file — never a
    // same-titled case elsewhere.
    const counterpart = sibling.replace(/\.fork\.test\.(tsx?)$/, ".test.$1");
    const counterpartText = upstreamTexts.get(counterpart);
    const counterpartTitles =
      counterpartText === undefined ? new Set<string>() : new Set(testCaseTitles(counterpartText));
    const baseText = baseTexts.get(counterpart);
    const baseBodies = new Map<string, ReadonlyArray<string>>();
    if (baseText !== undefined) {
      for (const title of testCaseTitles(baseText)) {
        const body = caseBodyForRename(baseText, title);
        if (body !== null) baseBodies.set(title, body);
      }
    }
    for (const title of [...new Set(testCaseTitles(text))].toSorted()) {
      if (declaredTitles.has(title)) continue;
      if (counterpartTitles.has(title)) {
        undeclared.push({ sibling, title });
        continue;
      }
      // Rename shape: the base carried a body under this title that the
      // assessed text dropped, while the assessed text carries that
      // same body under a new title — the head renamed the case in
      // place while the sibling still carries the base title, so no
      // shared title survives. That is undeclared too. The sibling
      // agreeing with the base body is not required: the sibling
      // predates the rename and may carry fork behaviour. A base-absent
      // counterpart leaves the old rule standing: no shared title, no
      // finding.
      if (baseText === undefined) continue;
      const baseBody = baseBodies.get(title);
      if (baseBody === undefined || baseBody.length === 0) continue;
      if (counterpartTitles.has(title)) continue;
      // The assessed text carries the base body under a new title:
      // some head case other than this title agrees with the base body.
      const baseLines = new Set(baseBody);
      const headBodies = new Map<string, ReadonlyArray<string>>();
      if (counterpartText !== undefined) {
        for (const headTitle of testCaseTitles(counterpartText)) {
          const body = caseBodyForRename(counterpartText, headTitle);
          if (body !== null) headBodies.set(headTitle, body);
        }
      }
      const headCarries = [...headBodies].some(
        ([headTitle, headBody]) =>
          headTitle !== title &&
          headBody.length > 0 &&
          headBody.every((line) => baseLines.has(line)) &&
          baseBody.every((line) => new Set(headBody).has(line)),
      );
      if (headCarries) undeclared.push({ sibling, title });
    }
  }

  return { refusals, superseded, undeclared, retireCandidates };
};
