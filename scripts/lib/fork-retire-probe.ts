// The retire-candidate probe's scope. Orientation proves a retire candidate by looking for the
// identifiers a fork commit introduces in the target tag's tree. An unscoped look answers the wrong
// question: it finds the words, not the code. On the `v0.0.41-nightly.20260908.1414` walk that
// returned verdicts such as `@t3tools/contracts` in an agent-harness document and `react-native` in
// an editor rule file, and roughly 35 of 40 rows read `retire-candidate` on evidence like that.
// The operator is told to test every such row; when almost every row is noise the test stops being
// run, and a proven keep is buried among them (RSI-Software/t3code-hyprws#688).

/** A diff of these says nothing about a fork commit's own identity. */
export const isOpaqueDiffPath = (path: string): boolean =>
  path === "pnpm-lock.yaml" || path.endsWith(".lock") || path.endsWith(".snap");

/**
 * Everything the probe must not read, as git pathspecs, so the search itself is scoped rather than
 * the results filtered afterwards. A dot directory at any depth is vendored, harness, CI, or editor
 * tooling — `.repos/`, `.macroscope/`, `.agents/`, `.cursor/`, `.github/`, `.devcontainer/` — and
 * `docs/` is prose. None of them implement a fork behaviour.
 */
export const RETIRE_PROBE_EXCLUSIONS: ReadonlyArray<string> = [
  ":(exclude,glob).*/**",
  ":(exclude,glob)**/.*/**",
  ":(exclude,glob)docs/**",
];

/** The same rule as {@link RETIRE_PROBE_EXCLUSIONS}, for a path the probe has already read back. */
export const isProductSourcePath = (path: string): boolean =>
  !path.startsWith("docs/") && !path.split("/").some((segment) => segment.startsWith("."));

/** `.ts` for `apps/web/src/a.ts`; empty for a path with no extension or a leading-dot basename. */
export const fileExtension = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
};

/** Prose never carries an implementation, whatever directory it sits in. */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".mdc",
  ".mdx",
  ".rst",
  ".td",
  ".txt",
]);

/**
 * The source file types the fork commit itself changed. A match only counts in one of these: a fork
 * commit that changes TypeScript is not superseded by its own strings turning up in a workflow file.
 */
export const forkCommitSourceExtensions = (diff: string): ReadonlySet<string> => {
  const extensions = new Set<string>();
  for (const line of diff.split("\n")) {
    const path = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)?.[1];
    if (path === undefined || path === "/dev/null" || isOpaqueDiffPath(path)) continue;
    const extension = fileExtension(path);
    if (extension === "" || PROSE_EXTENSIONS.has(extension)) continue;
    extensions.add(extension);
  }
  return extensions;
};

/**
 * An import specifier names the package, never the fork. Harvesting one puts a string every tree
 * that depends on that package already carries into the probe, and {@link isDefinitionOrImportSite}
 * then reads the dependency's own import line back as proof of the retirement. That is how
 * `smol-toml`, `effect/Effect` and `@effect/vitest` became retire evidence on the
 * `v0.0.41-nightly.20260910.1473` walk (RSI-Software/t3code-hyprws#750).
 */
export const isModuleSpecifierLine = (line: string): boolean =>
  /^\s*(?:import|export)\b[^=]*\bfrom\s*["'`]/.test(line) ||
  /^\s*import\s*["'`]/.test(line) ||
  /\b(?:require|import)\s*\(\s*["'`]/.test(line) ||
  /\bvi\.mock\s*\(\s*["'`]/.test(line);

/**
 * Fixture data reads as a long literal but names nothing: a timestamp, a filesystem path, a run of
 * digits or punctuation, or a quoted fragment of some other file's content. Every tree with a
 * similar fixture matches it, so it proves nothing about the fork behaviour.
 */
export const isFixtureLiteral = (literal: string): boolean =>
  /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(literal) ||
  /^(?:~|\.{1,2})?\/|^[A-Za-z]:\\/.test(literal) ||
  /["'`]/.test(literal) ||
  !/[A-Za-z]{3}/.test(literal);

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A name is evidence where it is defined or imported, never where it is merely mentioned. A bare
 * package name or environment-variable name matches every line that names it, which is how a
 * dependency label became a retirement verdict.
 */
export const isDefinitionOrImportSite = (identifier: string, text: string): boolean => {
  const name = escapeRegExp(identifier);
  return (
    new RegExp(`\\b(?:import|require|from)\\b.*${name}`).test(text) ||
    new RegExp(
      `\\b(?:export|const|let|var|function|class|interface|type|enum)\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s+)?${name}\\b`,
    ).test(text) ||
    new RegExp(`["'\`]${name}["'\`]\\s*:`).test(text) ||
    new RegExp(`\\b(?:it|test|describe)(?:\\.\\w+)*\\(\\s*["'\`]${name}`).test(text)
  );
};

/** The whole test one grep hit has to pass before it counts as evidence upstream carries the fork behaviour. */
export const isRetireEvidenceSite = (
  identifier: string,
  path: string,
  text: string,
  extensions: ReadonlySet<string>,
): boolean =>
  isProductSourcePath(path) &&
  extensions.has(fileExtension(path)) &&
  isDefinitionOrImportSite(identifier, text);
