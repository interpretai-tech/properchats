"use client";

import { GitBranch } from "lucide-react";
import {
  cloneElement,
  createContext,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";
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

/** A half-open `[start, end)` char range over a paragraph's concatenated text. */
type Range = { start: number; end: number };

/**
 * Locate `excerpt` inside `text` ignoring case and treating any run of
 * separators as equal. Separators are whitespace plus the markdown punctuation
 * `# > * _ \` ~ |` that `snippet()` collapses to a space when a thread is
 * claimed — so the range-finder normalizes identically to how the stored
 * highlight was produced. Returns the range in *raw* `text` offsets, or null
 * when it can't be found.
 *
 * We project both strings to a normalized form (lowercase, collapsed
 * separators) and keep an offset map from each normalized char back to its raw
 * index, so a match found in normalized space slices the raw text correctly.
 */
function findExcerptRange(text: string, excerpt: string): Range | null {
  const target = excerpt.replace(/[\s#>*_`~|]+/g, " ").trim().toLowerCase();
  if (!target) return null;

  // Build the normalized projection of `text` plus a raw-offset map. A run of
  // separator chars (whitespace or the markdown punctuation `snippet()` strips)
  // collapses to a single space mapped to the run's first char, so this matches
  // how a thread's highlight snippet was normalized when it was claimed.
  let norm = "";
  const rawAt: number[] = []; // rawAt[i] = raw index of norm[i]
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[\s#>*_`~|]/.test(ch)) {
      if (!inSpace && norm.length) {
        norm += " ";
        rawAt.push(i);
      }
      inSpace = true;
    } else {
      norm += ch.toLowerCase();
      rawAt.push(i);
      inSpace = false;
    }
  }
  const trimmed = norm.replace(/ $/, ""); // a trailing collapsed space never matters

  const at = trimmed.indexOf(target);
  if (at < 0) return null;
  const start = rawAt[at];
  // End is one past the last matched char; map the last normalized index to its
  // raw index, then advance past that whole raw char.
  const end = rawAt[at + target.length - 1] + 1;
  return { start, end };
}

/** Merge overlapping/adjacent ranges so a char is never double-wrapped. */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Walk `node`, wrapping the portions that fall within `ranges` (expressed in
 * concatenated-text offsets) in soft `<mark>`s. `offset` tracks where the
 * current node starts in that concatenated text. Returns the rewritten node and
 * the offset just past it. Element wrappers (e.g. <strong>, <a>) are preserved
 * via cloneElement and recursed into, so a highlight can span across them.
 */
function markRanges(
  node: ReactNode,
  ranges: Range[],
  offset: number,
  keyPath: string,
): { node: ReactNode; next: number } {
  if (typeof node === "string" || typeof node === "number") {
    const str = String(node);
    const start = offset;
    const end = offset + str.length;
    // Emit alternating plain / highlighted slices for any range overlapping this
    // text node. Spanning matches are handled because each text node is sliced
    // independently against the same global ranges.
    const parts: ReactNode[] = [];
    let cursor = start;
    for (const r of ranges) {
      if (r.end <= start || r.start >= end) continue; // no overlap
      const from = Math.max(r.start, start);
      const to = Math.min(r.end, end);
      if (from > cursor) parts.push(str.slice(cursor - start, from - start));
      parts.push(
        <mark key={`${keyPath}-mk-${from}`} className="branch-highlight">
          {str.slice(from - start, to - start)}
        </mark>,
      );
      cursor = to;
    }
    if (parts.length === 0) return { node: str, next: end };
    if (cursor < end) parts.push(str.slice(cursor - start));
    return { node: parts, next: end };
  }

  if (Array.isArray(node)) {
    let cur = offset;
    const out: ReactNode[] = node.map((child, i) => {
      const r = markRanges(child, ranges, cur, `${keyPath}-${i}`);
      cur = r.next;
      return r.node;
    });
    return { node: out, next: cur };
  }

  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    const inner = markRanges(el.props.children, ranges, offset, `${keyPath}-c`);
    // Preserve the element (and its props) so links/bold still render; only the
    // children are rewritten with the highlight slices.
    return {
      node: cloneElement(el, { key: el.key ?? keyPath }, inner.node),
      next: inner.next,
    };
  }

  // null / boolean / unknown: contributes no text.
  return { node, next: offset };
}

function Paragraph({ children }: { children?: ReactNode }) {
  const branch = useContext(BranchContext);
  const text = nodeText(children);
  // Threads branched from this exact paragraph get a persistent marker right
  // here, so the thread icon sits exactly where the branch was made.
  const threads = branch?.claimThreads?.(text) ?? [];

  // Soft-highlight the exact excerpt(s) each thread branched from, so the user
  // can see *where* in the paragraph a branch points. The stored highlight is a
  // normalized, possibly `…`-truncated snippet, so strip that and locate it in
  // the rendered text by whitespace-collapsed, case-insensitive match.
  const ranges = mergeRanges(
    threads
      .map((t) => (t.highlight ? t.highlight.replace(/…$/u, "").trim() : ""))
      .filter((ex) => ex.length > 0)
      .map((ex) => findExcerptRange(text, ex))
      .filter((r): r is Range => r != null),
  );
  // Degrade gracefully: if nothing matched (e.g. an excerpt spanning formatting
  // oddly), leave the children untouched rather than risk a bad slice.
  const content = ranges.length ? markRanges(children, ranges, 0, "hl").node : children;

  return (
    <p className="group/para relative pr-7">
      {content}
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
