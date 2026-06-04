"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Film,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Loader2,
  Music,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { getModel, modelLabel, providerInk, PROVIDERS } from "@/lib/models";
import { highlightMatchesText, snippet, useStore } from "@/lib/store";
import { ProviderDot } from "./ProviderDot";
import type { ConvNode, Message, Source } from "@/lib/types";
import { BranchContext, type BranchHandle, Markdown } from "./Markdown";

/** A markdown block that react-markdown renders as a <p> (so it can host an inline thread marker). */
function isParagraphBlock(block: string): boolean {
  const t = block.trim();
  if (!t) return false;
  const first = t.split("\n", 1)[0];
  // Exclude headings, blockquotes, list items, tables, fenced code, hr.
  if (/^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|```|~~~|\||-{3,}$|\*{3,}$)/.test(first)) return false;
  if (t.includes("\n|") || /^\|/.test(t)) return false;
  return true;
}

function ModelTag({ message }: { message: Message }) {
  if (!message.provider) return null;
  const label =
    message.modelName ??
    (message.modelId ? modelLabel(getModel(message.modelId), message.route ?? "interpret") : null);
  if (!label) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px]"
      style={{ color: providerInk(message.provider, 30, "--muted") }}
    >
      <ProviderDot provider={message.provider} />
      {label}
    </span>
  );
}

/** Host for a hostname-only display of a citation URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Citations gathered by a web-search / research / grounding capability. */
function Sources({ sources }: { sources: Source[] }) {
  return (
    <div data-testid="sources" className="mt-3 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
        <Globe size={12} />
        Sources
      </div>
      <ol className="flex flex-col gap-1">
        {sources.map((s, i) => (
          <li key={`${s.url}-${i}`} className="flex items-baseline gap-1.5 text-[12.5px]">
            <span className="text-faint">{i + 1}.</span>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate text-muted hover:text-accent hover:underline"
              title={s.url}
            >
              {s.title || hostOf(s.url)}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Collapsible "thinking & activity" panel: streamed reasoning + tool steps. */
function ThinkingTrace({
  reasoning,
  activity,
  streaming,
}: {
  reasoning?: string;
  activity?: string[];
  streaming: boolean;
}) {
  // Expanded by default so the reasoning/search activity stays visible during and
  // after the turn; the user can collapse it. Derived (no effect).
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? true;

  const hasReasoning = Boolean(reasoning && reasoning.trim());
  const hasActivity = Boolean(activity && activity.length);
  if (!hasReasoning && !hasActivity) return null;

  return (
    <div data-testid="thinking-trace" className="mb-2 overflow-hidden rounded-lg border border-line bg-surface-2/60">
      <button
        type="button"
        data-testid="thinking-toggle"
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-muted transition hover:text-ink"
      >
        {streaming ? (
          <Loader2 size={13} className="animate-spin text-accent" />
        ) : (
          <Sparkles size={13} className="text-accent" />
        )}
        <span>{streaming ? "Thinking…" : "Thoughts & activity"}</span>
        {open ? (
          <ChevronDown size={13} className="ml-auto opacity-60" />
        ) : (
          <ChevronRight size={13} className="ml-auto opacity-60" />
        )}
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2">
          {hasActivity && (
            <ul className="mb-1.5 flex flex-col gap-1" data-testid="activity-list">
              {activity!.map((a, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[12.5px] text-muted">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          )}
          {hasReasoning && (
            <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-faint">
              {reasoning}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadChips({
  childThreads,
  onOpen,
}: {
  childThreads: ConvNode[];
  onOpen: (id: string) => void;
}) {
  if (!childThreads.length) return null;
  return (
    <div className="mt-2.5 flex flex-col items-start gap-1.5">
      {childThreads.map((t) => {
        const model = getModel(t.currentModelId);
        const replies = t.messages.filter((m) => m.role === "user").length;
        const dot = <ProviderDot provider={model.provider} />;
        const repliesLabel = replies > 0 ? `${replies} repl${replies === 1 ? "y" : "ies"}` : "open";
        // When the thread was branched from a highlighted excerpt (including a
        // whole paragraph), show that excerpt right here at the branch point.
        if (t.highlight) {
          return (
            <button
              key={t.id}
              type="button"
              data-testid="thread-chip"
              onClick={() => onOpen(t.id)}
              className="group/chip flex w-full max-w-[460px] flex-col gap-1 rounded-lg border border-line bg-surface px-3 py-2 text-left transition hover:border-accent/40"
            >
              <span className="flex items-center gap-1.5 text-[11px] text-faint">
                <GitBranch size={12} className="text-accent" />
                <span className="font-medium text-muted">Branched on this excerpt</span>
                {dot}
                <span>{repliesLabel}</span>
              </span>
              <span className="border-l-2 border-accent/60 pl-2 text-[12.5px] italic text-muted line-clamp-2">
                “{t.highlight}”
              </span>
            </button>
          );
        }
        return (
          <button
            key={t.id}
            type="button"
            data-testid="thread-chip"
            onClick={() => onOpen(t.id)}
            className="group/chip flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-muted transition hover:border-accent/40 hover:text-ink"
          >
            <GitBranch size={13} className="text-accent" />
            <span className="max-w-[160px] truncate font-medium">{t.title}</span>
            {dot}
            <span className="text-faint">{repliesLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-faint transition hover:bg-surface-3 hover:text-ink",
        active && "text-accent",
      )}
    >
      {children}
    </button>
  );
}

export function MessageItem({
  message,
  nodeId,
  isStreaming,
  isLast,
  childThreads,
  canBranchHere,
}: {
  message: Message;
  nodeId: string;
  isStreaming: boolean;
  isLast: boolean;
  childThreads: ConvNode[];
  canBranchHere: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const branchThread = useStore((s) => s.branchThread);
  const openThread = useStore((s) => s.openThread);
  const regenerate = useStore((s) => s.regenerate);
  const generateWithProvider = useStore((s) => s.generateWithProvider);
  const status = useStore((s) => (isStreaming ? s.streamingStatus[nodeId] : undefined));

  const isUser = message.role === "user";
  const hasImages = Boolean(message.images && message.images.length);
  // Image-capable providers offered when an image turn was blocked (the selected
  // model can't generate images); lets the user pick which one to use.
  const fallback = message.capabilityFallback;
  const hasTrace = Boolean(
    (message.reasoning && message.reasoning.trim()) || (message.activity && message.activity.length),
  );
  const showThinking =
    isStreaming && !message.content.trim() && !message.error && !hasImages && !hasTrace;

  // Assign each thread to the first true paragraph (<p>) its excerpt matches, in
  // document order. Computed once (pure) so a thread renders its marker at
  // exactly one paragraph and is never both inline and a chip — and threads that
  // match no paragraph (headings, lists, whole-message branches) fall back to
  // chips instead of vanishing.
  const { byParaKey, assignedIds } = useMemo(() => {
    const paras = (message.content || "").split(/\n{2,}/).filter(isParagraphBlock);
    const map = new Map<string, ConvNode[]>();
    const assigned = new Set<string>();
    for (const p of paras) {
      const key = snippet(p, 100_000);
      for (const t of childThreads) {
        if (!t.highlight || assigned.has(t.id)) continue;
        if (highlightMatchesText(p, t.highlight)) {
          assigned.add(t.id);
          const arr = map.get(key) ?? [];
          arr.push(t);
          map.set(key, arr);
        }
      }
    }
    return { byParaKey: map, assignedIds: assigned };
  }, [message.content, childThreads]);
  const chipThreads = useMemo(
    () => childThreads.filter((t) => !assignedIds.has(t.id)),
    [childThreads, assignedIds],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const branch = () => branchThread(nodeId, message.id);

  // Slack-style per-paragraph branching: the paragraph text becomes the
  // highlighted excerpt the new thread focuses on, and any thread already
  // branched from a paragraph surfaces a marker inline at that paragraph.
  const branchCtx = useMemo<BranchHandle>(
    () => ({
      canBranch: canBranchHere,
      onBranch: (excerpt: string) => {
        branchThread(nodeId, message.id, excerpt);
      },
      claimThreads: (excerpt: string) => byParaKey.get(snippet(excerpt, 100_000)) ?? [],
      onOpenThread: (id: string) => openThread(id),
    }),
    [canBranchHere, branchThread, nodeId, message.id, byParaKey, openThread],
  );

  return (
    <div
      data-testid="message"
      data-role={message.role}
      data-node-id={nodeId}
      data-message-id={message.id}
      className={cn("group animate-fade-in", isUser ? "flex flex-col items-end" : "flex flex-col items-start")}
    >
      {isUser ? (
        <div className="flex max-w-[85%] flex-col items-end">
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
              {message.attachments.map((a, i) =>
                a.modality === "image" && /^(data:|https?:)/.test(a.uri) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={a.uri}
                    alt="attachment"
                    className="max-h-40 rounded-xl border border-line object-cover"
                  />
                ) : (
                  <span
                    key={i}
                    data-testid="attachment-chip"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-muted"
                  >
                    {a.modality === "video" ? (
                      <Film size={13} className="text-accent" />
                    ) : a.modality === "audio" ? (
                      <Music size={13} className="text-accent" />
                    ) : a.modality === "pdf" ? (
                      <FileText size={13} className="text-accent" />
                    ) : (
                      <ImageIcon size={13} className="text-accent" />
                    )}
                    <span className="max-w-[180px] truncate">{a.mime || a.modality}</span>
                  </span>
                ),
              )}
            </div>
          )}
          {message.content && (
            <div
              className="whitespace-pre-wrap break-words rounded-2xl bg-user-bubble px-4 py-2.5 text-[15px] text-ink"
              style={{ lineHeight: "var(--prose-leading, 1.5)" }}
            >
              {message.content}
            </div>
          )}
        </div>
      ) : (
        <div
          className="w-full max-w-none"
          // Barely tint the reply text toward the producing model's signature
          // color, so the main chat hints at which provider wrote it.
          style={message.provider ? { color: providerInk(message.provider, 10) } : undefined}
        >
          <ThinkingTrace
            reasoning={message.reasoning}
            activity={message.activity}
            streaming={isStreaming}
          />
          {showThinking ? (
            <div className="flex items-center gap-2 py-1 text-faint" aria-label="Thinking">
              {status ? (
                <span className="text-[13px]">{status}</span>
              ) : (
                <>
                  <span className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-current" />
                </>
              )}
            </div>
          ) : (
            <div className={cn(isStreaming && message.content && "stream-caret")}>
              <BranchContext.Provider value={branchCtx}>
                <Markdown>{message.content}</Markdown>
              </BranchContext.Provider>
            </div>
          )}
          {isStreaming && status && message.content.trim() ? (
            <div className="mt-2 text-[12px] text-muted">{status}</div>
          ) : null}
          {message.images && message.images.length > 0 && (
            <div className="mt-3 flex flex-col gap-3">
              {message.images.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt="Generated image"
                  className="max-w-full rounded-xl border border-line"
                />
              ))}
            </div>
          )}
          {/* A generated image still inline (data:) after streaming won't be
              persisted (inline images are stripped to protect localStorage
              quota), so warn the user it may vanish on refresh. */}
          {!isStreaming && message.images?.some((src) => src.startsWith("data:")) && (
            <div
              data-testid="image-too-large"
              className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span className="break-words">
                This image won&apos;t be saved and may disappear after you refresh. Try generating a
                smaller image.
              </span>
            </div>
          )}
          {message.sources && message.sources.length > 0 && <Sources sources={message.sources} />}
          {message.error && (
            <div
              data-testid="message-error"
              className="mt-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger"
            >
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span className="break-words">{message.error}</span>
            </div>
          )}
          {fallback && fallback.providers.length > 0 && (
            <div data-testid="capability-fallback" className="mt-2 flex flex-wrap gap-1.5">
              {fallback.providers.map((p) => (
                <button
                  key={p}
                  type="button"
                  data-testid={`capability-fallback-${p}`}
                  disabled={isStreaming}
                  onClick={() => generateWithProvider(nodeId, message.id, fallback.capability, p)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] font-medium text-muted transition hover:border-accent/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ProviderDot provider={p} />
                  Use {PROVIDERS[p].label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <ThreadChips childThreads={chipThreads} onOpen={openThread} />

      {/* Action row */}
      {!isStreaming && (
        <div
          className={cn(
            "mt-1 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100",
            isUser ? "flex-row-reverse" : "flex-row",
          )}
        >
          <IconButton label={copied ? "Copied" : "Copy"} onClick={copy} active={copied}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
          {!isUser && isLast && (
            <IconButton label="Regenerate" onClick={() => regenerate(nodeId)}>
              <RotateCcw size={15} />
            </IconButton>
          )}
          {canBranchHere && (
            <IconButton label="Branch into thread" onClick={branch}>
              <GitBranch size={15} />
            </IconButton>
          )}
          {!isUser && !showThinking && (
            <span className="ml-1.5">
              <ModelTag message={message} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
