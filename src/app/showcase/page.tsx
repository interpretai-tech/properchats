"use client";

import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";

const SAMPLE = `# Rendering showcase

A quick brown fox jumps over the lazy dog. This paragraph exists to judge the
**reading rhythm**, _italic emphasis_, line-height, and measure of the assistant
prose. Here is some \`inline code\` and a [link to anthropic](https://anthropic.com).

## Lists and structure

1. First, gather the requirements.
2. Then sketch the data model.
   - a nested bullet
   - another, with \`inline\` token
3. Ship it.

- [x] Set up the project
- [ ] Write the tests
- [ ] Celebrate

> Threads behave like Slack threads: branch a message, switch providers, keep the
> context. This blockquote checks the left rule and muted color.

### A table

| Provider | Tier   | Model            | Route     |
|----------|--------|------------------|-----------|
| Claude   | large  | Opus 4.7         | direct    |
| ChatGPT  | small  | GPT-4.1          | direct    |
| Gemini   | medium | Gemini 3 Flash   | interpret |

## Code blocks

\`\`\`python
from dataclasses import dataclass

@dataclass(frozen=True)
class ChatTurn:
    role: str          # "user" | "assistant" | "system"
    content: str
    created_at: str | None = None

def summarize(turns: list[ChatTurn]) -> str:
    """Compact a conversation into a dense summary."""
    return "\\n".join(f"- {t.role}: {t.content[:80]}" for t in turns if t.content)
\`\`\`

\`\`\`typescript
export async function* dispatch(input: DispatchInput): AsyncGenerator<StreamEvent> {
  const res = await fetch(url, { method: "POST", body: JSON.stringify(input) });
  if (!res.ok) {
    yield { type: "error", error: \`HTTP \${res.status}\` };
    return;
  }
  for await (const ev of iterateSSE(res)) {
    if (ev.type === "delta") yield { type: "delta", text: ev.text as string };
  }
}
\`\`\`

\`\`\`bash
# Stream a reply from the proxy
curl -N -X POST http://localhost:3000/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{"route":"direct","provider":"anthropic","model":"claude-opus-4-8"}'
\`\`\`

\`\`\`json
{ "type": "done", "usage": { "input": 19, "output": 9 }, "stopReason": "end_turn" }
\`\`\`

\`\`\`diff
- const route = "interpret";
+ const route = chooseRoute(provider, keys, serverConfig);
\`\`\`

## Math

Inline math like $e^{i\\pi} + 1 = 0$ and a display block:

$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

## LaTeX viewer

A fenced \`latex\` block is typeset by the LaTeX viewer (toggle Rendered / Source):

\`\`\`latex
\\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi
\`\`\`

\`\`\`latex
\\begin{aligned}
\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\
\\nabla \\cdot \\mathbf{B} &= 0
\\end{aligned}
\`\`\`

Prose and math mix in one block, and escaped currency stays literal text:

\`\`\`latex
The mass-energy relation $E = mc^2$ and a budget line of \\$5 per unit.
\`\`\`

---

That's the full surface.`;

export default function Showcase() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <div className="min-h-dvh bg-bg text-ink">
      <div className="mx-auto max-w-chat px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">
            Markdown / code showcase
          </h2>
          <button
            type="button"
            onClick={() => setDark((v) => !v)}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-muted hover:text-ink"
          >
            {dark ? "Light" : "Dark"} mode
          </button>
        </div>

        {/* user bubble (sans) for contrast against assistant prose (serif) */}
        <div className="mb-6 flex justify-end">
          <div className="max-w-[85%] rounded-2xl bg-user-bubble px-4 py-2.5 text-[15px] leading-relaxed">
            Show me the full rendering surface - code, tables, math, lists.
          </div>
        </div>

        <Markdown>{SAMPLE}</Markdown>
      </div>
    </div>
  );
}
