// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

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
 * The upstream titles a sibling text declares as superseded for one upstream
 * path, each paired with whether the sibling carries at least one test
 * case beside the declaration. A bare declaration buys no exemption: the
 * sibling must hold the replacement behaviour, or deleting upstream
 * coverage would pass silently. Additive-only reader over
 * `collectForkSupersedes` (RSI-Software/t3code-hyprws#1208); the parser
 * itself is untouched.
 */
export const supersededTitlesByPath = (
  text: string,
  path: string,
): ReadonlyArray<{ readonly title: string; readonly hasReplacement: boolean }> => {
  const hasReplacement = testCaseTitles(text).length > 0;
  return collectForkSupersedes(text).declarations.flatMap((declaration) =>
    declaration.upstreamPath === path ? [{ title: declaration.upstreamTitle, hasReplacement }] : [],
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

const caseBody = (text: string): string =>
  stripDeclarationCalls(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && line !== "/*",
    )
    .join("\n");

// The declaration calls themselves are bookkeeping, not behaviour: the
// retire comparison reads the sibling's case body without them.
const stripDeclarationCalls = (text: string): string =>
  text.replace(/forkSupersedes\s*\(\s*\{[^}]*\}\s*\)\s*;?/gs, "");

/**
 * Every declaration in the fork siblings, judged against the target tree's
 * texts. `siblings` maps a sibling path to its text; `upstreamTexts` maps an
 * upstream path to its target-tree text (absent when the tree no longer
 * carries the file). A declaration whose upstream case now carries the fork
 * behaviour — its significant lines are a subset of the upstream file's — is
 * a retire candidate: the declaration and its sibling case go in the same
 * change. Judgement is advisory per se; the caller decides what fails.
 */
export const assessForkSupersedes = (
  siblings: ReadonlyMap<string, string>,
  upstreamTexts: ReadonlyMap<string, string>,
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
      superseded.push({ path: declaration.upstreamPath, title: declaration.upstreamTitle });
      // The fork behaviour adopted upstream: every significant sibling
      // line except the declaration itself already sits in the upstream
      // file, so the divergence is gone and the declaration with its case
      // is deletion-ready.
      const upstreamBody = new Set(caseBody(upstreamText).split("\n"));
      const siblingBody = caseBody(text).split("\n");
      if (siblingBody.length > 0 && siblingBody.every((line) => upstreamBody.has(line))) {
        retireCandidates.push({ ...declaration, sibling });
      }
    }
    // A sibling case that shares an upstream title contradicts it by
    // definition: same name, fork-owned behaviour. Without a declaration
    // that contradiction is unrecorded. The counterpart is the sibling
    // with the `.fork` segment dropped, so a sibling contradicts only its
    // own upstream file — never a same-titled case elsewhere.
    const counterpart = sibling.replace(/\.fork\.test\.(tsx?)$/, ".test.$1");
    const counterpartText = upstreamTexts.get(counterpart);
    const counterpartTitles =
      counterpartText === undefined ? new Set<string>() : new Set(testCaseTitles(counterpartText));
    for (const title of [...new Set(testCaseTitles(text))].toSorted()) {
      if (declaredTitles.has(title) || !counterpartTitles.has(title)) continue;
      undeclared.push({ sibling, title });
    }
  }

  return { refusals, superseded, undeclared, retireCandidates };
};
