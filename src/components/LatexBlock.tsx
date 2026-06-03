"use client";

import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { renderLatexToHtml } from "@/lib/latex";

/**
 * In-chat LaTeX viewer. The Markdown renderer routes ```latex / ```tex fences
 * here instead of to `CodeBlock`, so a LaTeX block from a model is typeset with
 * KaTeX (Rendered) and can be flipped back to its raw form (Source). Mirrors the
 * CodeBlock chrome (header label + copy) but reads like prose, not a code surface.
 */
export function LatexBlock({ code }: { code: string }) {
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const [copied, setCopied] = useState(false);
  const { html, error } = useMemo(() => renderLatexToHtml(code), [code]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const tab = (m: "rendered" | "source", label: string) => (
    <button
      type="button"
      data-testid={`latex-toggle-${m}`}
      aria-pressed={mode === m}
      onClick={() => setMode(m)}
      className={cn(
        "rounded px-2 py-0.5 font-medium transition",
        mode === m
          ? "bg-bg text-ink shadow-sm ring-1 ring-line"
          : "text-faint hover:text-ink",
      )}
    >
      {label}
    </button>
  );

  return (
    <div
      data-testid="latex-block"
      className="group/latex my-4 overflow-hidden rounded-xl border border-line bg-surface shadow-sm ring-1 ring-black/5"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="select-none text-[11.5px] font-medium tracking-wide text-faint">LaTeX</span>
        <div className="flex items-center gap-1">
          <div className="flex items-center rounded-md bg-surface-3 p-0.5 text-[11.5px]">
            {tab("rendered", "Rendered")}
            {tab("source", "Source")}
          </div>
          <button
            type="button"
            data-testid="latex-copy"
            onClick={copy}
            aria-label="Copy LaTeX"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium text-faint transition hover:bg-surface-3 hover:text-ink"
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
      </div>

      {mode === "rendered" ? (
        <div className="px-4 py-3">
          {html ? (
            <div
              data-testid="latex-render"
              className="latex-rendered overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <div className="text-[13px] text-faint">Empty LaTeX block.</div>
          )}
          {error && (
            <button
              type="button"
              data-testid="latex-error-hint"
              onClick={() => setMode("source")}
              title={error}
              className="mt-2 text-[11.5px] text-danger hover:underline"
            >
              Couldn&rsquo;t fully render this LaTeX - view source
            </button>
          )}
        </div>
      ) : (
        <pre data-testid="latex-source" className="latex-source m-0 overflow-x-auto px-4 py-3 text-[13px]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
