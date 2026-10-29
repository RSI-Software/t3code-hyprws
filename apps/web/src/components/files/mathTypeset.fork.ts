import katex from "katex";
import "katex/dist/katex.min.css";

import { LRUCache } from "../../lib/lruCache";

// The editor's KaTeX chunk, loaded once a formula renders; chat math moved to Words' SVG.
// "" records a parse error.
const typesetCache = new LRUCache<string>(1000, 4 * 1024 * 1024);

const OPTIONS = {
  output: "htmlAndMathml",
  throwOnError: true,
  // No \href, \url, \htmlClass, or other commands that emit active HTML.
  trust: false,
  strict: "ignore",
  maxSize: 20,
  maxExpand: 1000,
} as const;

/**
 * Escapes each `%` written right after other text, as in `\text{3.18% yield}`.
 * A `%` at a line start or after whitespace stays a comment. Skips escapes and
 * `\verb` like KaTeX's lexer, in one linear pass.
 */
function escapeLiteralPercents(tex: string): string {
  let repaired = "";
  let copied = 0;
  let index = 0;
  while (index < tex.length) {
    const char = tex[index];
    if (char === "\\") {
      if (tex.startsWith("\\verb", index)) {
        const starred = tex[index + 5] === "*";
        const delimiter = tex[index + (starred ? 6 : 5)];
        if (delimiter !== undefined && (starred || !/[*a-zA-Z]/.test(delimiter))) {
          const bodyStart = index + (starred ? 7 : 6);
          let close = bodyStart;
          while (close < tex.length && ![delimiter, "\n", "\r"].includes(tex[close]!)) close++;
          // KaTeX rejects a \verb that does not close on its own line.
          if (tex[close] !== delimiter) return tex;
          index = close + 1;
          continue;
        }
      }
      // A control symbol such as `\%` or `\\` is two characters.
      index += 2;
    } else if (char === "%" && index > 0 && !/\s/.test(tex[index - 1]!)) {
      repaired += `${tex.slice(copied, index)}\\%`;
      copied = ++index;
    } else if (char === "%") {
      const newline = tex.indexOf("\n", index);
      index = newline === -1 ? tex.length : newline + 1;
    } else {
      index++;
    }
  }
  return copied === 0 ? tex : repaired + tex.slice(copied);
}

/** KaTeX markup for `tex`, or "" when it does not parse. */
export function typeset(tex: string, display: boolean): string {
  const key = `${display ? "display" : "inline"}:${tex}`;
  const cached = typesetCache.get(key);
  if (cached !== null) return cached;
  const options = { ...OPTIONS, displayMode: display };
  let html = "";
  try {
    html = katex.renderToString(tex, options);
  } catch {
    const repaired = escapeLiteralPercents(tex);
    if (repaired !== tex) {
      try {
        html = katex.renderToString(repaired, options);
      } catch {
        // Unfinished or unsupported TeX stays readable as its source.
      }
    }
  }
  typesetCache.set(key, html, (key.length + html.length) * 2);
  return html;
}
