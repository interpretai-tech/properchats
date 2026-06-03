import katex from "katex";

/**
 * Typeset a fenced LaTeX block to HTML with KaTeX, for the in-chat LaTeX viewer
 * (see `components/LatexBlock`). This is distinct from the inline `$...$` /
 * `$$...$$` math that `remark-math` + `rehype-katex` already render in prose:
 * here we take the raw body of a ```latex / ```tex fence (which would otherwise
 * show as plain source) and render it.
 *
 * Two shapes are handled, covering what models actually emit:
 *  - Bare LaTeX with no math delimiters (e.g. `\frac{a}{b}` or a `\begin{aligned}`
 *    environment): the whole block is one display equation. Blank-line-separated
 *    chunks become stacked display equations.
 *  - Delimiter-marked LaTeX mixing prose and math (`text $x^2$ more \[y\]`): split
 *    into text and math segments; math renders via KaTeX, text is unescaped and
 *    HTML-escaped. Backslash-escaped delimiters (`\$`) are treated as literal
 *    text, not math boundaries.
 *
 * KaTeX runs with `trust: false` (no raw HTML / `\href` escape hatch) so the
 * output is safe to inject. Every render goes through `renderMath`, which never
 * throws (a hard KaTeX error degrades to escaped source) and flags parse failures
 * so the viewer can offer a "view source" affordance.
 */

const KATEX_OPTS = {
  output: "htmlAndMathml" as const,
  trust: false,
  strict: false as const,
  errorColor: "var(--danger)",
};

export interface RenderedLatex {
  html: string;
  /** True if any segment failed to typeset cleanly (KaTeX rendered an error). */
  error: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Common LaTeX text-mode escapes to their literal characters (e.g. `\$` -> `$`). */
function unescapeLatexText(s: string): string {
  return s.replace(/\\([$%&#_{}])/g, "$1");
}

/** A run of non-math prose between math segments, rendered as plain text. */
function textSpan(s: string): string {
  return `<span class="latex-text">${escapeHtml(unescapeLatexText(s))}</span>`;
}

/**
 * Render one math expression. Single-parse with `throwOnError: false` so KaTeX
 * renders malformed input inline (in `errorColor`, with the message in a title);
 * we detect that via the `katex-error` class to flag `error`. A hard, non-parse
 * KaTeX failure (which still throws even with `throwOnError: false`) is caught so
 * it can never crash the surrounding React render - it degrades to escaped source.
 */
function renderMath(tex: string, displayMode: boolean): RenderedLatex {
  const t = tex.trim();
  if (!t) return { html: "", error: null };
  try {
    const html = katex.renderToString(t, { ...KATEX_OPTS, displayMode, throwOnError: false });
    return { html, error: /katex-error/.test(html) ? "LaTeX parse error" : null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      html: `<span class="latex-text" style="color:var(--danger)">${escapeHtml(t)}</span>`,
      error,
    };
  }
}

// Inline/display math delimiters. The leading `(?<!\\)` and the escape-aware
// inline body ensure a backslash-escaped delimiter (`\$`, `\\[`) is NOT treated
// as a boundary, so currency like `\$5` stays literal text. Longest-first so
// `$$` wins over `$`.
const DELIM =
  /(?<!\\)(?:\$\$[\s\S]+?(?<!\\)\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?:\\.|[^\\$\n])+?\$)/g;

export function renderLatexToHtml(src: string): RenderedLatex {
  const text = (src ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return { html: "", error: null };

  // No math delimiters at all: treat the block as display math. Blank-line-
  // separated chunks (multiple equations) each get their own display block.
  if (!/\$|\\\(|\\\[/.test(text)) {
    const chunks = text.split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
    if (chunks.length <= 1) return renderMath(text, true);
    let html = "";
    let error: string | null = null;
    for (const c of chunks) {
      const r = renderMath(c, true);
      html += r.html;
      if (r.error && !error) error = r.error;
    }
    return { html, error };
  }

  // Delimiter present: render each balanced math segment, render the prose
  // between as text. If no balanced pair is found (a lone/escaped/streaming-
  // truncated delimiter), the whole body falls through as a single text span.
  let html = "";
  let error: string | null = null;
  let last = 0;
  for (const m of text.matchAll(DELIM)) {
    const idx = m.index ?? 0;
    if (idx > last) html += textSpan(text.slice(last, idx));
    const tok = m[0];
    let inner = tok;
    let display = false;
    if (tok.startsWith("$$")) {
      inner = tok.slice(2, -2);
      display = true;
    } else if (tok.startsWith("\\[")) {
      inner = tok.slice(2, -2);
      display = true;
    } else if (tok.startsWith("\\(")) {
      inner = tok.slice(2, -2);
    } else {
      inner = tok.slice(1, -1);
    }
    const r = renderMath(inner, display);
    html += r.html;
    if (r.error && !error) error = r.error;
    last = idx + tok.length;
  }
  if (last < text.length) html += textSpan(text.slice(last));
  return { html, error };
}
