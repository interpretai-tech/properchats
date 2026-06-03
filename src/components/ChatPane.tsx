"use client";

import { ArrowUpRight, PanelLeft } from "lucide-react";
import { useEffect, useState } from "react";
import type { Suggestion } from "@/app/api/suggestions/route";
import { useStore } from "@/lib/store";
import { Logo } from "./Logo";
import { Composer } from "./Composer";
import { CompactButton } from "./CompactButton";
import { MessageList } from "./MessageList";
import { ThreadTreeButton } from "./ThreadTreeButton";

// Starter questions are cached in localStorage so the empty-chat screen shows
// real hot/trending questions instantly (and offline). We only go back to the
// network to refresh once the local copy is an hour old, and we never fall back
// to generic prompts - a failed refresh just keeps the last cached questions.
const SUGGESTIONS_KEY = "properchat-suggestions";
const SUGGESTIONS_TTL_MS = 3_600_000; // refresh the local cache at most hourly

type CachedSuggestions = { items: Suggestion[]; at: number };

function readCachedSuggestions(): CachedSuggestions | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SUGGESTIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as CachedSuggestions | null) : null;
    if (!parsed || !Array.isArray(parsed.items) || typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedSuggestions(items: Suggestion[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SUGGESTIONS_KEY, JSON.stringify({ items, at: Date.now() }));
  } catch {
    // best-effort cache; ignore quota / serialization errors
  }
}

function Hero({ nodeId }: { nodeId: string }) {
  const sendMessage = useStore((s) => s.sendMessage);
  // Seed from the local cache so cached hot/trending questions paint instantly.
  // App only mounts this after store hydration, so it never runs during SSR -
  // reading localStorage in the initializer is safe (no hydration mismatch).
  const [suggestions, setSuggestions] = useState<Suggestion[]>(
    () => readCachedSuggestions()?.items.slice(0, 4) ?? [],
  );
  // No generic fallback any more, so anything shown is a real pooled question.
  const live = suggestions.length > 0;

  useEffect(() => {
    // Only hit the network when the local cache is missing or over an hour old;
    // within the hour the cached questions are authoritative.
    const cached = readCachedSuggestions();
    if (cached && Date.now() - cached.at < SUGGESTIONS_TTL_MS) return;

    let alive = true;
    fetch("/api/suggestions")
      .then((r) => r.json())
      .then((d: { suggestions?: Suggestion[]; source?: string }) => {
        if (!alive || !Array.isArray(d.suggestions) || !d.suggestions.length) return;
        const items = d.suggestions.slice(0, 4);
        setSuggestions(items);
        writeCachedSuggestions(items); // cache locally; refresh again in an hour
      })
      .catch(() => {
        // Keep the cached questions (or nothing) - never generic prompts.
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="mb-7 flex flex-col items-center text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-accent-fg shadow-sm">
          <Logo size={26} />
        </div>
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">
          How can I help today?
        </h1>
        <p className="mt-1.5 text-[14px] text-muted">
          Chat with any model. Branch any reply into a thread.
        </p>
      </div>
      <div className="w-full">
        <Composer nodeId={nodeId} autoFocus placeholder="Message ProperChat…" testId="composer-main" />
      </div>
      <div className="mx-auto mt-1 flex w-full max-w-chat flex-wrap justify-center gap-2 px-4">
        {suggestions.map((s) => (
          <div
            key={s.text}
            data-testid="suggestion"
            className="group flex items-center gap-0.5 rounded-full border border-line bg-surface py-1.5 pl-3.5 pr-1.5 text-[13px] text-muted transition hover:border-faint"
          >
            <button
              type="button"
              onClick={() => void sendMessage(nodeId, s.text)}
              className="max-w-[280px] truncate hover:text-ink"
            >
              {s.text}
            </button>
            {s.url && (
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="suggestion-source"
                title={`Where this is from: ${s.source}`}
                aria-label={`See the source of this question on ${s.source}`}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-faint transition hover:bg-surface-3 hover:text-accent"
              >
                <ArrowUpRight size={13} />
              </a>
            )}
          </div>
        ))}
      </div>
      {live && (
        <p className="mt-2.5 text-[11px] text-faint" data-testid="suggestions-attribution">
          Real questions people are asking, pooled live from{" "}
          <a
            href="https://stackexchange.com/questions?tab=hot"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-faint underline-offset-2 transition hover:text-accent"
          >
            Stack Exchange
          </a>{" "}
          and Hacker News · tap the arrow on any to see its thread.
        </p>
      )}
    </div>
  );
}

export function ChatPane({
  chatId,
  onToggleSidebar,
}: {
  chatId: string;
  onToggleSidebar: () => void;
}) {
  const chat = useStore((s) => s.chats[chatId]);
  const rootId = chat?.rootNodeId;
  const node = useStore((s) => (rootId ? s.nodes[rootId] : undefined));

  if (!chat || !rootId || !node) return null;
  const empty = node.messages.length === 0;

  return (
    <div data-testid="chat-pane" className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onToggleSidebar}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink md:hidden"
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={18} />
          </button>
          <h2 className="truncate text-[15px] font-medium text-ink">{chat.title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <CompactButton nodeId={rootId} />
          <ThreadTreeButton chatId={chatId} />
        </div>
      </header>

      {empty ? (
        <Hero nodeId={rootId} />
      ) : (
        <>
          <MessageList nodeId={rootId} />
          <Composer nodeId={rootId} testId="composer-main" />
        </>
      )}
    </div>
  );
}
