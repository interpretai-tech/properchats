"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { CODE_THEME, getHighlighter, resolveLang } from "@/lib/shiki";

const DISPLAY: Record<string, string> = {
  javascript: "JavaScript", typescript: "TypeScript", jsx: "JSX", tsx: "TSX",
  python: "Python", bash: "Bash", json: "JSON", html: "HTML", css: "CSS",
  scss: "SCSS", markdown: "Markdown", sql: "SQL", go: "Go", rust: "Rust",
  java: "Java", c: "C", cpp: "C++", csharp: "C#", yaml: "YAML", toml: "TOML",
  ruby: "Ruby", php: "PHP", swift: "Swift", kotlin: "Kotlin", diff: "Diff",
  dockerfile: "Dockerfile", graphql: "GraphQL", lua: "Lua", r: "R",
  plaintext: "",
};

interface Rendered {
  html: string;
  bg: string;
  fg: string;
  lang: string;
}

const FALLBACK_BG = "#0d1117";

/**
 * Fenced code block rendered with Shiki (VS Code-grade highlighting) inside
 * claude.ai-style chrome: a translucent header with the language and a copy
 * button over a dark, horizontally-scrollable code surface. Highlighting is
 * synchronous once the shared highlighter has loaded, so it tracks streaming
 * tokens smoothly; until then the raw code is shown on the same dark surface.
 */
export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    getHighlighter()
      .then((hl) => {
        if (!active) return;
        const lang = resolveLang(language, hl.getLoadedLanguages());
        const theme = hl.getTheme(CODE_THEME);
        const html = hl.codeToHtml(code, {
          lang,
          theme: CODE_THEME,
          transformers: [
            {
              pre(node) {
                // Strip Shiki's inline bg so our container controls the surface.
                node.properties.style = `color:${theme.fg}`;
              },
            },
          ],
        });
        setRendered({ html, bg: theme.bg ?? FALLBACK_BG, fg: theme.fg ?? "#e6edf3", lang });
      })
      .catch(() => active && setRendered(null));
    return () => {
      active = false;
    };
  }, [code, language]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const bg = rendered?.bg ?? FALLBACK_BG;
  const label =
    DISPLAY[rendered?.lang ?? ""] ??
    (rendered?.lang && rendered.lang !== "plaintext" ? rendered.lang : "");

  return (
    <div
      data-testid="code-block"
      className="group/code my-4 overflow-hidden rounded-xl border border-white/10 shadow-sm ring-1 ring-black/5"
      style={{ background: bg }}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-[1.1rem] py-1.5">
        <span className="select-none text-[11.5px] font-medium tracking-wide text-white/55">
          {label || "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium text-white/55 transition hover:bg-white/10 hover:text-white/90"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check size={13} /> Copied
            </>
          ) : (
            <>
              <Copy size={13} /> Copy
            </>
          )}
        </button>
      </div>
      {rendered ? (
        <div className="code-surface" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      ) : (
        <pre className="code-surface code-fallback" style={{ color: "#e6edf3" }}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
