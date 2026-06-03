"use client";

import { GitBranch } from "lucide-react";
import { createContext, memo, type ReactNode, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ConvNode } from "@/lib/types";
import { CodeBlock } from "./CodeBlock";
import { LatexBlock } from "./LatexBlock";

/**
 * Lets the message that owns this markdown offer a Slack-style "branch this
 * paragraph" affordance on each paragraph, and surface a marker inline at the
 * exact paragraph a thread was branched from. Provided by MessageItem; null
 * elsewhere (so the markdown renders plainly with no branch affordances).
 */
export interface BranchHandle {
  canBranch: boolean;
  onBranch: (excerpt: string) => void;
  /**
   * Claim the child threads branched from this paragraph's text. Claim-based so
   * a thread renders its marker at exactly one paragraph (the first match), even
   * if the excerpt also appears in later paragraphs.
   */
  claimThreads?: (excerpt: string) => ConvNode[];
  /** Open an existing thread in the side panel. */
  onOpenThread?: (id: string) => void;
}
export const BranchContext = createContext<BranchHandle | null>(null);

/** Flatten React children to their plain text (used as the branch excerpt). */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/** Persistent markers for threads branched from this block, shown inline at the branch point. */
function ThreadMarkers({ threads, onOpen }: { threads: ConvNode[]; onOpen?: (id: string) => void }) {
  if (!threads.length) return null;
  return (
    <>
      {threads.map((t) => {
        const replies = t.messages.filter((m) => m.role === "user").length;
        return (
          <button
            key={t.id}
            type="button"
            data-testid="paragraph-thread-marker"
            contentEditable={false}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onOpen?.(t.id)}
            title={`Open thread: ${t.title}`}
            aria-label={`Open thread: ${t.title}`}
            className="ml-1.5 inline-flex select-none items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-accent transition hover:bg-accent/20"
          >
            <GitBranch size={12} />
            {replies > 0 && <span>{replies}</span>}
          </button>
        );
      })}
    </>
  );
}

function Paragraph({ children }: { children?: ReactNode }) {
  const branch = useContext(BranchContext);
  const text = nodeText(children);
  // Threads branched from this exact paragraph get a persistent marker right
  // here, so the thread icon sits exactly where the branch was made.
  const threads = branch?.claimThreads?.(text) ?? [];
  return (
    <p className="group/para relative pr-7">
      {children}
      <ThreadMarkers threads={threads} onOpen={branch?.onOpenThread} />
      {branch?.canBranch && (
        <button
          type="button"
          data-testid="paragraph-branch"
          contentEditable={false}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => branch.onBranch(text)}
          title="Branch this paragraph into a thread"
          aria-label="Branch this paragraph into a thread"
          className="absolute right-0 top-0.5 hidden h-6 w-6 select-none items-center justify-center rounded-md border border-line bg-surface text-faint opacity-0 shadow-sm transition hover:border-accent/40 hover:text-accent group-hover/para:opacity-100 md:flex"
        >
          <GitBranch size={13} />
        </button>
      )}
    </p>
  );
}

const components: Components = {
  // Unwrap <pre> so our CodeBlock isn't nested inside it.
  pre: ({ children }) => <>{children}</>,
  p: Paragraph,
  code({ className, children }) {
    const text = String(children ?? "").replace(/\n$/, "");
    const match = /language-(\w+)/.exec(className || "");
    const lang = match?.[1]?.toLowerCase();
    const isBlock = Boolean(match) || text.includes("\n");
    if (!isBlock) return <code className={className}>{children}</code>;
    if (lang === "latex" || lang === "tex") return <LatexBlock code={text} />;
    return <CodeBlock language={lang ?? "text"} code={text} />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

function MarkdownImpl({ children }: { children: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Memoized so streaming siblings don't force re-parse of settled messages. */
export const Markdown = memo(MarkdownImpl, (a, b) => a.children === b.children);
